'use client';

import { Activity, Download, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ActiveSymbol } from '@deriv/core';
import type { UseDCirclesAutoTradingReturn } from '@/hooks/use-d-circles-auto-trading';
import { DEFAULT_D_CIRCLE_MARKETS, isEvenDigit } from '@/lib/d-circles-strategy';

interface DCirclesDashboardProps {
  isConnected: boolean;
  symbols: ActiveSymbol[];
  auto: UseDCirclesAutoTradingReturn;
}

export function DCirclesDashboard({ isConnected, symbols, auto }: DCirclesDashboardProps) {
  const available = new Set(symbols.map((symbol) => symbol.underlying_symbol));
  const analysis = auto.displayAnalysis;
  const best = auto.bestMarket;

  return (
    <div className="grid gap-3 lg:grid-cols-[1.15fr_0.85fr]">
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4" />
                EVEN/ODD D-Circles Scanner
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Best market: {best?.symbol ?? 'waiting for 1000 ticks'} · Phase: {auto.stats.currentPhase}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={auto.autoTrade ? 'secondary' : 'default'}
                disabled={!isConnected}
                onClick={auto.autoTrade ? auto.stopAutoTrade : auto.startAutoTrade}
              >
                {auto.autoTrade ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
                {auto.autoTrade ? 'Stop Auto' : 'Start Auto'}
              </Button>
              <Button size="sm" variant="outline" onClick={auto.exportLogs} disabled={auto.logs.length === 0}>
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {DEFAULT_D_CIRCLE_MARKETS.map((market) => {
              const checked = auto.selectedMarkets.includes(market);
              const disabled = !available.has(market);
              return (
                <label
                  key={market}
                  className={`flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-sm ${checked ? 'border-primary bg-primary/5' : 'border-border'} ${disabled ? 'opacity-45' : ''}`}
                >
                  <span>{market}</span>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => {
                      auto.setSelectedMarkets(
                        event.target.checked
                          ? [...auto.selectedMarkets, market]
                          : auto.selectedMarkets.filter((item) => item !== market)
                      );
                    }}
                  />
                </label>
              );
            })}
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="Connection" value={isConnected ? 'Connected' : 'Disconnected'} />
            <Metric label="Current market" value={auto.stats.currentMarket ?? '-'} />
            <Metric label="Current stake" value={`${auto.stats.currentStake.toFixed(2)} USD`} />
            <Metric label="P/L" value={`${auto.stats.sessionProfit.toFixed(2)} USD`} tone={auto.stats.sessionProfit >= 0 ? 'good' : 'bad'} />
            <Metric label="Wins / Losses" value={`${auto.stats.wins} / ${auto.stats.losses}`} />
            <Metric label="Auto Trade" value={auto.autoTrade ? 'ON' : 'OFF'} />
            <Metric label="Open trade" value={auto.stats.openTradeType ?? '-'} />
            <Metric label="Setup" value={auto.stats.currentSetupDetected ? 'Detected' : 'Waiting'} />
          </div>

          <div className="rounded-lg border p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">{analysis?.symbol ?? 'No market ready'}</p>
                <p className="text-xs text-muted-foreground">
                  Tick progress: {analysis ? `${analysis.progress}/1000` : '0/1000'} · Current digit: {analysis?.lastDigit ?? '-'}
                </p>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                EVEN {analysis?.evenTotal.toFixed(2) ?? '0.00'}% · ODD {analysis?.oddTotal.toFixed(2) ?? '0.00'}%
              </div>
            </div>
            <div className="grid grid-cols-10 gap-1.5">
              {(analysis?.percentages ?? new Array(10).fill(0)).map((pct, digit) => {
                const role =
                  digit === analysis?.greenDigit ? 'green' :
                  digit === analysis?.blueDigit ? 'blue' :
                  digit === analysis?.redDigit ? 'red' :
                  digit === analysis?.yellowDigit ? 'yellow' : 'neutral';
                return <DigitBar key={digit} digit={digit} percentage={pct} role={role} />;
              })}
            </div>
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
              <Role label="Green" digit={analysis?.greenDigit} />
              <Role label="Blue" digit={analysis?.blueDigit} />
              <Role label="Red" digit={analysis?.redDigit} />
              <Role label="Yellow" digit={analysis?.yellowDigit} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Risk & Phase Controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Initial stake" value={auto.settings.initialStake} onChange={(value) => auto.updateSetting('initialStake', value)} suffix="USD" />
            <NumberField label="Multiplier" value={auto.settings.martingaleMultiplier} onChange={(value) => auto.updateSetting('martingaleMultiplier', value)} />
            <NumberField label="Take Profit" value={auto.settings.takeProfit} onChange={(value) => auto.updateSetting('takeProfit', value)} suffix="USD" />
            <NumberField label="Stop Loss" value={auto.settings.stopLoss} onChange={(value) => auto.updateSetting('stopLoss', value)} suffix="USD" />
            <NumberField label="Duration" value={String(auto.settings.contractDuration)} onChange={(value) => auto.updateSetting('contractDuration', Math.max(1, parseInt(value, 10) || 1))} suffix="ticks" />
            <NumberField label="Max steps" value={String(auto.settings.maxMartingaleSteps)} onChange={(value) => auto.updateSetting('maxMartingaleSteps', Math.max(0, parseInt(value, 10) || 0))} />
          </div>
          <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
            <span>Martingale</span>
            <input
              type="checkbox"
              checked={auto.settings.martingaleOn}
              onChange={(event) => auto.updateSetting('martingaleOn', event.target.checked)}
            />
          </label>
          <div className="rounded-lg border p-3">
            <p className="text-sm font-semibold">Recent logs</p>
            <div className="mt-2 max-h-52 space-y-2 overflow-auto pr-1">
              {auto.logs.length === 0 ? (
                <p className="text-xs text-muted-foreground">No setup or trade logs yet.</p>
              ) : (
                auto.logs.slice(0, 8).map((log) => (
                  <div key={`${log.timestamp}-${log.message}`} className="rounded-md bg-muted/40 p-2 text-xs">
                    <p className="font-medium">{log.market} · {log.phase} · {log.message}</p>
                    <p className="text-muted-foreground">{new Date(log.timestamp).toLocaleString()} · {log.tradeType ?? 'setup'} · {log.profitLoss?.toFixed(2) ?? '-'}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 truncate text-sm font-semibold ${tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : ''}`}>{value}</p>
    </div>
  );
}

function NumberField({ label, value, onChange, suffix }: { label: string; value: string; onChange: (value: string) => void; suffix?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input type="number" min={0} value={value} onChange={(event) => onChange(event.target.value)} labelRight={suffix} />
    </div>
  );
}

function DigitBar({ digit, percentage, role }: { digit: number; percentage: number; role: 'green' | 'blue' | 'red' | 'yellow' | 'neutral' }) {
  const color = {
    green: 'bg-emerald-500',
    blue: 'bg-sky-500',
    red: 'bg-red-500',
    yellow: 'bg-amber-400',
    neutral: isEvenDigit(digit) ? 'bg-zinc-500' : 'bg-zinc-300',
  }[role];
  return (
    <div className="flex h-36 flex-col items-center justify-end gap-1">
      <span className="text-[10px] text-muted-foreground">{percentage.toFixed(1)}%</span>
      <div className="flex h-24 w-full items-end rounded-sm bg-muted">
        <div className={`w-full rounded-sm ${color}`} style={{ height: `${Math.max(4, percentage * 8)}%` }} />
      </div>
      <span className="text-xs font-semibold">{digit}</span>
    </div>
  );
}

function Role({ label, digit }: { label: string; digit: number | null | undefined }) {
  return (
    <div className="rounded-md bg-muted/40 px-2 py-1">
      {label}: <span className="font-semibold">{digit ?? '-'}</span>
    </div>
  );
}
