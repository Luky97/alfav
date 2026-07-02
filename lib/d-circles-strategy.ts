import { getLastDigit } from './digit-stats';

export const DEFAULT_D_CIRCLE_MARKETS = [
  'R_10',
  'R_25',
  'R_50',
  'R_75',
  'R_100',
  '1HZ10V',
  '1HZ25V',
  '1HZ50V',
  '1HZ75V',
  '1HZ100V',
] as const;

export type DCirclePhase =
  | 'SCANNING'
  | 'ENTER_EVEN'
  | 'SWITCH_TO_ODD'
  | 'WAIT_FOR_SHIFT'
  | 'RUN_BOT_ON_EVEN'
  | 'STOPPED';

export type DCircleTradeType = 'DIGITEVEN' | 'DIGITODD';

export interface DCircleConfig {
  tickWindow: number;
  minEvenDominanceGap: number;
  minGreenPercentage: number;
  maxRedPercentage: number;
  balanceGapThreshold: number;
  shiftWaitTicks: number;
  contractDuration: number;
  maxOpenTrades: number;
}

export interface DCircleAnalysis {
  symbol: string;
  progress: number;
  isReady: boolean;
  counts: number[];
  percentages: number[];
  greenDigit: number | null;
  blueDigit: number | null;
  redDigit: number | null;
  yellowDigit: number | null;
  evenTotal: number;
  oddTotal: number;
  dominanceGap: number;
  score: number;
  setupDetected: boolean;
  flatDistribution: boolean;
  lastDigit: number | null;
  ticksSincePhaseStart: number;
}

export interface DCircleLogEntry {
  timestamp: string;
  market: string;
  phase: DCirclePhase;
  greenDigit: number | null;
  blueDigit: number | null;
  redDigit: number | null;
  yellowDigit: number | null;
  percentages: number[];
  tradeType?: DCircleTradeType;
  stake?: number;
  result?: 'win' | 'loss' | 'pending' | 'setup';
  profitLoss?: number;
  message: string;
}

export class TickBuffer {
  private prices: number[] = [];
  private phaseStartLength = 0;

  constructor(readonly windowSize: number) {}

  seed(prices: number[]): void {
    this.prices = prices.slice(-this.windowSize);
    this.phaseStartLength = this.prices.length;
  }

  push(price: number): void {
    this.prices.push(price);
    if (this.prices.length > this.windowSize) this.prices.shift();
  }

  markPhaseStart(): void {
    this.phaseStartLength = this.prices.length;
  }

  get values(): number[] {
    return this.prices;
  }

  get length(): number {
    return this.prices.length;
  }

  get ticksSincePhaseStart(): number {
    return Math.max(0, this.prices.length - this.phaseStartLength);
  }
}

export class DigitDistributionAnalyzer {
  analyze(symbol: string, buffer: TickBuffer, pipSize: number): Omit<DCircleAnalysis, 'score' | 'setupDetected' | 'flatDistribution'> {
    const counts = new Array(10).fill(0);
    for (const price of buffer.values) counts[getLastDigit(price, pipSize)]++;

    const totalTicks = buffer.length;
    const percentages = counts.map((count) => (totalTicks > 0 ? (count / totalTicks) * 100 : 0));
    const rankedHigh = percentages.map((value, digit) => ({ value, digit })).sort((a, b) => b.value - a.value || a.digit - b.digit);
    const rankedLow = [...rankedHigh].sort((a, b) => a.value - b.value || a.digit - b.digit);
    const evenTotal = [0, 2, 4, 6, 8].reduce((sum, digit) => sum + percentages[digit], 0);
    const oddTotal = 100 - evenTotal;
    const lastPrice = buffer.values[buffer.values.length - 1];

    return {
      symbol,
      progress: Math.min(totalTicks, buffer.windowSize),
      isReady: totalTicks >= buffer.windowSize,
      counts,
      percentages,
      greenDigit: rankedHigh[0]?.digit ?? null,
      blueDigit: rankedHigh[1]?.digit ?? null,
      redDigit: rankedLow[0]?.digit ?? null,
      yellowDigit: rankedLow[1]?.digit ?? null,
      evenTotal,
      oddTotal,
      dominanceGap: evenTotal - oddTotal,
      lastDigit: lastPrice === undefined ? null : getLastDigit(lastPrice, pipSize),
      ticksSincePhaseStart: buffer.ticksSincePhaseStart,
    };
  }
}

export class DCircleDetector {
  constructor(private readonly config: DCircleConfig) {}

  score(analysis: Omit<DCircleAnalysis, 'score' | 'setupDetected' | 'flatDistribution'>): DCircleAnalysis {
    const greenEven = isEvenDigit(analysis.greenDigit);
    const blueEven = isEvenDigit(analysis.blueDigit);
    const redOdd = isOddDigit(analysis.redDigit);
    const evenDominant = analysis.evenTotal > analysis.oddTotal;
    const greenPct = analysis.greenDigit === null ? 0 : analysis.percentages[analysis.greenDigit];
    const redPct = analysis.redDigit === null ? 100 : analysis.percentages[analysis.redDigit];
    const flatDistribution = Math.abs(analysis.dominanceGap) < this.config.minEvenDominanceGap;

    let score = analysis.isReady ? 0 : -5;
    if (greenEven) score += 3;
    if (redOdd) score += 2;
    if (blueEven) score += 2;
    if (evenDominant) score += 2;
    if (redPct <= this.config.maxRedPercentage) score += 1;
    if (greenPct >= this.config.minGreenPercentage) score += 1;
    if (flatDistribution) score -= 3;

    const setupDetected =
      analysis.isReady &&
      greenEven &&
      redOdd &&
      evenDominant &&
      analysis.dominanceGap >= this.config.minEvenDominanceGap &&
      greenPct >= this.config.minGreenPercentage &&
      redPct <= this.config.maxRedPercentage &&
      !flatDistribution;

    return { ...analysis, score, setupDetected, flatDistribution };
  }

  redBarTimingConfirmed(analysis: DCircleAnalysis): boolean {
    return analysis.setupDetected && analysis.lastDigit !== null && isEvenDigit(analysis.lastDigit);
  }

  oddReversalConfirmed(current: DCircleAnalysis, previous?: DCircleAnalysis): boolean {
    if (!current.isReady || !isOddDigit(current.redDigit)) return false;
    const oddMomentum = current.oddTotal >= 49 || current.dominanceGap < this.config.minEvenDominanceGap;
    const evenFading = previous ? current.evenTotal <= previous.evenTotal : current.evenTotal < 51;
    return oddMomentum && evenFading;
  }

  marketBalanceConfirmed(current: DCircleAnalysis, original?: DCircleAnalysis): boolean {
    const balanced = Math.abs(current.dominanceGap) <= this.config.balanceGapThreshold;
    const structureChanged =
      !!original &&
      (current.greenDigit !== original.greenDigit ||
        current.redDigit !== original.redDigit ||
        current.yellowDigit !== original.yellowDigit);
    return current.ticksSincePhaseStart >= this.config.shiftWaitTicks || balanced || structureChanged;
  }
}

export class MarketScanner {
  selectBest(analyses: DCircleAnalysis[]): DCircleAnalysis | null {
    const ready = analyses.filter((item) => item.isReady);
    if (ready.length === 0) return null;
    return ready.sort((a, b) => b.score - a.score || Math.abs(b.dominanceGap) - Math.abs(a.dominanceGap))[0] ?? null;
  }
}

export class PhaseManager {
  phase: DCirclePhase = 'SCANNING';

  set(next: DCirclePhase): void {
    this.phase = next;
  }
}

export class RiskManager {
  canPlaceStake(stake: number, sessionProfit: number, stopLoss: number): boolean {
    if (stopLoss <= 0) return true;
    return sessionProfit - stake >= -stopLoss;
  }

  nextStake(initialStake: number, previousStake: number, multiplier: number, martingaleOn: boolean, step: number, maxSteps: number): number {
    if (!martingaleOn || step >= maxSteps) return initialStake;
    return roundMoney(previousStake * multiplier);
  }
}

export class TradeManager {
  createProposalPayload(symbol: string, contractType: DCircleTradeType, stake: number, duration: number) {
    return {
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      duration,
      duration_unit: 't',
      underlying_symbol: symbol,
    };
  }
}

export class DerivWebSocketClient {
  constructor(private readonly ws: { send: <T = Record<string, unknown>>(payload: Record<string, unknown>) => Promise<T> }) {}

  async requestProposal(symbol: string, contractType: DCircleTradeType, stake: number, duration: number): Promise<{ id: string; askPrice: number }> {
    const manager = new TradeManager();
    const response = await this.ws.send<{ proposal?: { id: string; ask_price: number } }>(
      manager.createProposalPayload(symbol, contractType, stake, duration)
    );
    if (!response.proposal) throw new Error('Proposal unavailable');
    return { id: response.proposal.id, askPrice: response.proposal.ask_price };
  }

  async buy(proposalId: string, askPrice: number): Promise<number> {
    const response = await this.ws.send<{ buy?: { contract_id: number } }>({ buy: proposalId, price: String(askPrice) });
    if (!response.buy) throw new Error('Buy response missing contract');
    return response.buy.contract_id;
  }
}

export function isEvenDigit(digit: number | null): boolean {
  return digit !== null && digit % 2 === 0;
}

export function isOddDigit(digit: number | null): boolean {
  return digit !== null && digit % 2 === 1;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
