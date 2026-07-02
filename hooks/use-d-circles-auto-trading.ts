'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DerivWS, ActiveSymbol, Tick, TicksHistoryResponse } from '@deriv/core';
import { pipSizeFromPip } from '@/lib/digit-stats';
import {
  DEFAULT_D_CIRCLE_MARKETS,
  DCircleDetector,
  DerivWebSocketClient,
  DigitDistributionAnalyzer,
  MarketScanner,
  PhaseManager,
  RiskManager,
  TickBuffer,
  type DCircleAnalysis,
  type DCircleConfig,
  type DCircleLogEntry,
  type DCirclePhase,
  type DCircleTradeType,
  roundMoney,
} from '@/lib/d-circles-strategy';

const DEFAULT_CONFIG: DCircleConfig = {
  tickWindow: 1000,
  minEvenDominanceGap: 1,
  minGreenPercentage: 10.5,
  maxRedPercentage: 9.5,
  balanceGapThreshold: 0.5,
  shiftWaitTicks: 100,
  contractDuration: 1,
  maxOpenTrades: 1,
};

interface AutoTradeSettings {
  initialStake: string;
  martingaleMultiplier: string;
  takeProfit: string;
  stopLoss: string;
  contractDuration: number;
  maxMartingaleSteps: number;
  martingaleOn: boolean;
}

interface SessionStats {
  sessionProfit: number;
  wins: number;
  losses: number;
  currentStake: number;
  currentMarket: string | null;
  currentPhase: DCirclePhase;
  currentSetupDetected: boolean;
  openTradeType: DCircleTradeType | null;
}

interface OpenTrade {
  contractId: number;
  market: string;
  tradeType: DCircleTradeType;
  stake: number;
}

export interface UseDCirclesAutoTradingReturn {
  settings: AutoTradeSettings;
  updateSetting: <K extends keyof AutoTradeSettings>(key: K, value: AutoTradeSettings[K]) => void;
  selectedMarkets: string[];
  setSelectedMarkets: (markets: string[]) => void;
  analyses: DCircleAnalysis[];
  bestMarket: DCircleAnalysis | null;
  displayAnalysis: DCircleAnalysis | null;
  autoTrade: boolean;
  startAutoTrade: () => void;
  stopAutoTrade: () => void;
  stats: SessionStats;
  logs: DCircleLogEntry[];
  exportLogs: () => void;
}

export function useDCirclesAutoTrading(
  ws: DerivWS | null,
  isConnected: boolean,
  symbols: ActiveSymbol[],
  isAuthenticated: boolean
): UseDCirclesAutoTradingReturn {
  const [settings, setSettings] = useState<AutoTradeSettings>({
    initialStake: '1',
    martingaleMultiplier: '2',
    takeProfit: '10',
    stopLoss: '10',
    contractDuration: 1,
    maxMartingaleSteps: 3,
    martingaleOn: true,
  });
  const [selectedMarkets, setSelectedMarkets] = useState<string[]>([...DEFAULT_D_CIRCLE_MARKETS]);
  const [analyses, setAnalyses] = useState<DCircleAnalysis[]>([]);
  const [bestMarket, setBestMarket] = useState<DCircleAnalysis | null>(null);
  const [autoTrade, setAutoTrade] = useState(false);
  const [logs, setLogs] = useState<DCircleLogEntry[]>([]);
  const [stats, setStats] = useState<SessionStats>({
    sessionProfit: 0,
    wins: 0,
    losses: 0,
    currentStake: 1,
    currentMarket: null,
    currentPhase: 'SCANNING',
    currentSetupDetected: false,
    openTradeType: null,
  });

  const config = useMemo<DCircleConfig>(() => ({ ...DEFAULT_CONFIG, contractDuration: settings.contractDuration }), [settings.contractDuration]);
  const buffersRef = useRef(new Map<string, TickBuffer>());
  const pipSizesRef = useRef(new Map<string, number>());
  const analysesRef = useRef(new Map<string, DCircleAnalysis>());
  const previousAnalysesRef = useRef(new Map<string, DCircleAnalysis>());
  const setupAtSwitchRef = useRef<DCircleAnalysis | undefined>(undefined);
  const phaseRef = useRef(new PhaseManager());
  const openTradeRef = useRef<OpenTrade | null>(null);
  const autoTradeRef = useRef(false);
  const currentStakeRef = useRef(1);
  const martingaleStepRef = useRef(0);
  const sessionProfitRef = useRef(0);
  const winsRef = useRef(0);
  const lossesRef = useRef(0);
  const subscribedRef = useRef(new Map<string, () => void>());
  const runningTradeRef = useRef(false);

  const analyzer = useMemo(() => new DigitDistributionAnalyzer(), []);
  const detector = useMemo(() => new DCircleDetector(config), [config]);
  const scanner = useMemo(() => new MarketScanner(), []);
  const risk = useMemo(() => new RiskManager(), []);

  const updateSetting = useCallback(<K extends keyof AutoTradeSettings>(key: K, value: AutoTradeSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    if (key === 'initialStake') {
      const parsed = parseFloat(String(value));
      if (Number.isFinite(parsed) && parsed > 0) currentStakeRef.current = parsed;
    }
  }, []);

  const addLog = useCallback((entry: Omit<DCircleLogEntry, 'timestamp'>) => {
    setLogs((prev) => [{ ...entry, timestamp: new Date().toISOString() }, ...prev].slice(0, 300));
  }, []);

  const syncStats = useCallback((partial: Partial<SessionStats> = {}) => {
    setStats((prev) => ({
      ...prev,
      sessionProfit: roundMoney(sessionProfitRef.current),
      wins: winsRef.current,
      losses: lossesRef.current,
      currentStake: roundMoney(currentStakeRef.current),
      currentPhase: phaseRef.current.phase,
      currentSetupDetected: bestMarket?.setupDetected ?? prev.currentSetupDetected,
      ...partial,
    }));
  }, [bestMarket]);

  const stopAutoTrade = useCallback(() => {
    autoTradeRef.current = false;
    setAutoTrade(false);
    phaseRef.current.set('STOPPED');
    syncStats({ currentPhase: 'STOPPED' });
  }, [syncStats]);

  const updateAnalysis = useCallback((symbol: string) => {
    const buffer = buffersRef.current.get(symbol);
    const pipSize = pipSizesRef.current.get(symbol);
    if (!buffer || pipSize === undefined) return;

    const previous = analysesRef.current.get(symbol);
    const raw = analyzer.analyze(symbol, buffer, pipSize);
    const scored = detector.score(raw);
    if (previous) previousAnalysesRef.current.set(symbol, previous);
    analysesRef.current.set(symbol, scored);

    const nextAnalyses = Array.from(analysesRef.current.values());
    const best = scanner.selectBest(nextAnalyses);
    setAnalyses(nextAnalyses);
    setBestMarket(best);
    syncStats({
      currentMarket: best?.symbol ?? null,
      currentSetupDetected: best?.setupDetected ?? false,
    });
  }, [analyzer, detector, scanner, syncStats]);

  const placeTrade = useCallback(async (analysis: DCircleAnalysis, tradeType: DCircleTradeType) => {
    if (!ws || !isConnected || !isAuthenticated || runningTradeRef.current || openTradeRef.current) return;
    const initialStake = parseFloat(settings.initialStake) || 0;
    const stopLoss = parseFloat(settings.stopLoss) || 0;
    const stake = roundMoney(currentStakeRef.current || initialStake);
    if (stake <= 0 || !risk.canPlaceStake(stake, sessionProfitRef.current, stopLoss)) {
      addLog({ market: analysis.symbol, phase: phaseRef.current.phase, greenDigit: analysis.greenDigit, blueDigit: analysis.blueDigit, redDigit: analysis.redDigit, yellowDigit: analysis.yellowDigit, percentages: analysis.percentages, tradeType, stake, result: 'loss', message: 'Trade blocked by stop-loss risk guard' });
      stopAutoTrade();
      return;
    }

    runningTradeRef.current = true;
    syncStats({ openTradeType: tradeType, currentMarket: analysis.symbol });
    addLog({ market: analysis.symbol, phase: phaseRef.current.phase, greenDigit: analysis.greenDigit, blueDigit: analysis.blueDigit, redDigit: analysis.redDigit, yellowDigit: analysis.yellowDigit, percentages: analysis.percentages, tradeType, stake, result: 'pending', message: 'D-Circles trade requested' });

    try {
      const client = new DerivWebSocketClient(ws);
      const proposal = await client.requestProposal(analysis.symbol, tradeType, stake, settings.contractDuration);
      const contractId = await client.buy(proposal.id, proposal.askPrice);
      openTradeRef.current = { contractId, market: analysis.symbol, tradeType, stake };

      const sub = await ws.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (data) => {
        const contract = data.proposal_open_contract as { status?: string; is_sold?: number; is_expired?: number; profit?: string | number } | undefined;
        if (!contract || !openTradeRef.current || openTradeRef.current.contractId !== contractId) return;
        const closed = !!contract.is_sold || !!contract.is_expired || contract.status !== 'open';
        if (!closed) return;

        const profit = typeof contract.profit === 'number' ? contract.profit : parseFloat(contract.profit ?? '0');
        const won = profit > 0;
        sessionProfitRef.current = roundMoney(sessionProfitRef.current + profit);
        if (won) winsRef.current += 1;
        else lossesRef.current += 1;

        const oldTrade = openTradeRef.current;
        openTradeRef.current = null;
        runningTradeRef.current = false;
        sub.unsubscribe();

        if (won) {
          currentStakeRef.current = initialStake;
          martingaleStepRef.current = 0;
          phaseRef.current.set(oldTrade.tradeType === 'DIGITEVEN' ? 'SWITCH_TO_ODD' : 'WAIT_FOR_SHIFT');
          if (oldTrade.tradeType === 'DIGITEVEN') setupAtSwitchRef.current = analysis;
          const buffer = buffersRef.current.get(oldTrade.market);
          buffer?.markPhaseStart();
        } else {
          const multiplier = parseFloat(settings.martingaleMultiplier) || 1;
          currentStakeRef.current = risk.nextStake(initialStake, oldTrade.stake, multiplier, settings.martingaleOn, martingaleStepRef.current, settings.maxMartingaleSteps);
          martingaleStepRef.current += settings.martingaleOn ? 1 : 0;
        }

        addLog({ market: oldTrade.market, phase: phaseRef.current.phase, greenDigit: analysis.greenDigit, blueDigit: analysis.blueDigit, redDigit: analysis.redDigit, yellowDigit: analysis.yellowDigit, percentages: analysis.percentages, tradeType: oldTrade.tradeType, stake: oldTrade.stake, result: won ? 'win' : 'loss', profitLoss: profit, message: won ? 'Contract closed with profit' : 'Contract closed with loss' });

        const takeProfit = parseFloat(settings.takeProfit) || 0;
        const maxLoss = parseFloat(settings.stopLoss) || 0;
        if ((takeProfit > 0 && sessionProfitRef.current >= takeProfit) || (maxLoss > 0 && sessionProfitRef.current <= -maxLoss)) {
          stopAutoTrade();
        } else {
          syncStats({ openTradeType: null, currentPhase: phaseRef.current.phase });
        }
      });
    } catch (error) {
      runningTradeRef.current = false;
      openTradeRef.current = null;
      addLog({ market: analysis.symbol, phase: phaseRef.current.phase, greenDigit: analysis.greenDigit, blueDigit: analysis.blueDigit, redDigit: analysis.redDigit, yellowDigit: analysis.yellowDigit, percentages: analysis.percentages, tradeType, stake, result: 'loss', message: error instanceof Error ? error.message : 'Trade failed' });
      syncStats({ openTradeType: null });
    }
  }, [addLog, isAuthenticated, isConnected, risk, settings, stopAutoTrade, syncStats, ws]);

  useEffect(() => {
    if (!autoTrade || openTradeRef.current || runningTradeRef.current) return;
    const best = bestMarket;
    if (!best || !best.isReady) return;
    const phase = phaseRef.current.phase;

    if (phase === 'SCANNING' || phase === 'RUN_BOT_ON_EVEN') {
      if (best.setupDetected) {
        phaseRef.current.set('ENTER_EVEN');
        addLog({ market: best.symbol, phase: 'ENTER_EVEN', greenDigit: best.greenDigit, blueDigit: best.blueDigit, redDigit: best.redDigit, yellowDigit: best.yellowDigit, percentages: best.percentages, result: 'setup', message: 'EVEN overfed setup detected' });
        syncStats({ currentPhase: 'ENTER_EVEN', currentMarket: best.symbol, currentSetupDetected: true });
      }
      return;
    }

    if (phase === 'ENTER_EVEN' && detector.redBarTimingConfirmed(best)) {
      void placeTrade(best, 'DIGITEVEN');
      return;
    }

    if (phase === 'SWITCH_TO_ODD') {
      const previous = previousAnalysesRef.current.get(best.symbol);
      if (detector.oddReversalConfirmed(best, previous)) void placeTrade(best, 'DIGITODD');
      return;
    }

    if (phase === 'WAIT_FOR_SHIFT' && detector.marketBalanceConfirmed(best, setupAtSwitchRef.current)) {
      phaseRef.current.set('RUN_BOT_ON_EVEN');
      syncStats({ currentPhase: 'RUN_BOT_ON_EVEN' });
    }
  }, [addLog, autoTrade, bestMarket, detector, placeTrade, syncStats]);

  useEffect(() => {
    if (!ws || !isConnected) return;
    const available = new Map(symbols.map((symbol) => [symbol.underlying_symbol, symbol]));
    const wanted = selectedMarkets.filter((market) => available.has(market));
    let disposed = false;

    for (const symbol of wanted) {
      if (subscribedRef.current.has(symbol)) continue;
      const active = available.get(symbol)!;
      const buffer = new TickBuffer(config.tickWindow);
      buffersRef.current.set(symbol, buffer);
      pipSizesRef.current.set(symbol, pipSizeFromPip(active.pip_size));

      ws.send<TicksHistoryResponse>({ ticks_history: symbol, end: 'latest', start: 1, count: config.tickWindow, style: 'ticks' })
        .then((response) => {
          if (disposed) return;
          buffer.seed(response.history?.prices ?? []);
          updateAnalysis(symbol);
          return ws.subscribe({ ticks: symbol }, (data) => {
            const tick = (data as { tick?: Tick }).tick;
            if (!tick) return;
            if (tick.pip_size) pipSizesRef.current.set(symbol, tick.pip_size);
            buffer.push(tick.quote);
            updateAnalysis(symbol);
          });
        })
        .then((sub) => {
          if (!sub) return;
          if (disposed) sub.unsubscribe();
          else subscribedRef.current.set(symbol, sub.unsubscribe);
        })
        .catch(() => {});
    }

    for (const [symbol, unsubscribe] of subscribedRef.current) {
      if (wanted.includes(symbol)) continue;
      unsubscribe();
      subscribedRef.current.delete(symbol);
      buffersRef.current.delete(symbol);
      analysesRef.current.delete(symbol);
      previousAnalysesRef.current.delete(symbol);
    }

    return () => {
      disposed = true;
    };
  }, [config.tickWindow, isConnected, selectedMarkets, symbols, updateAnalysis, ws]);

  useEffect(() => {
    if (!isConnected && autoTradeRef.current) stopAutoTrade();
  }, [isConnected, stopAutoTrade]);

  const startAutoTrade = useCallback(() => {
    const initialStake = parseFloat(settings.initialStake) || 0;
    currentStakeRef.current = initialStake;
    martingaleStepRef.current = 0;
    sessionProfitRef.current = 0;
    winsRef.current = 0;
    lossesRef.current = 0;
    openTradeRef.current = null;
    autoTradeRef.current = true;
    setAutoTrade(true);
    phaseRef.current.set('SCANNING');
    syncStats({ currentPhase: 'SCANNING', currentStake: initialStake, openTradeType: null });
  }, [settings.initialStake, syncStats]);

  const exportLogs = useCallback(() => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `d-circles-report-${new Date().toISOString()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [logs]);

  const displayAnalysis = bestMarket ?? analyses.find((item) => item.isReady) ?? analyses[0] ?? null;

  return {
    settings,
    updateSetting,
    selectedMarkets,
    setSelectedMarkets,
    analyses,
    bestMarket,
    displayAnalysis,
    autoTrade,
    startAutoTrade,
    stopAutoTrade,
    stats,
    logs,
    exportLogs,
  };
}
