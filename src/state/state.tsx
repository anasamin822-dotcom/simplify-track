// App state: owns the Store + SyncEngine lifecycle and exposes data to screens.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { Account, CanonicalTxn } from '../core/types.ts';
import type { Store } from '../core/store.ts';
import { MemoryStore } from '../core/store.ts';
import { SyncEngine } from '../core/sync.ts';
import type { SyncResult } from '../core/sync.ts';
import { computeMonthTotals, MonthTotals } from '../core/totals.ts';

const DEFAULT_BASE_URL = Platform.OS === 'android' ? 'http://10.0.2.2:4010' : 'http://localhost:4010';
const META_SERVER_URL = 'server_url';

export interface AppState {
  ready: boolean;
  txns: CanonicalTxn[];
  accounts: Map<string, Account>;
  months: MonthTotals[];
  syncing: boolean;
  syncProgress: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  quarantined: { count: number; examples: { id: string; reason: string }[]; truncated: boolean }; // unreadable server records still unresolved - totals may be incomplete; truncated: count is an upper bound
  serverUrl: string;
  setServerUrl(url: string): Promise<void>;
  refresh(): Promise<SyncResult>;
  reload(): Promise<void>;
  // Set when the configured server rejected the sync history from a previous
  // backend: replacing local data then needs the user's explicit choice.
  serverSwitchPending: { previousUrl: string | null } | null; // previous backend URL (null = never recorded)
  confirmServerSwitch(): Promise<void>; // replace local history with the new server's data
  dismissServerSwitch(): Promise<void>; // keep history, restore the previous server URL
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider missing');
  return v;
}

// storeFactory resolves per-platform (storeFactory.web.ts on web) - imported
// without an explicit extension so Metro can apply platform resolution.
async function openStore(): Promise<Store> {
  const { openDeviceStore } = await import('../core/storeFactory');
  return openDeviceStore();
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<Store | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [txns, setTxns] = useState<CanonicalTxn[]>([]);
  const [accounts, setAccounts] = useState<Map<string, Account>>(new Map());
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [serverUrl, setServerUrlState] = useState(DEFAULT_BASE_URL);
  const [serverSwitchPending, setServerSwitchPending] = useState<{ previousUrl: string | null } | null>(null);
  const [quarantined, setQuarantined] = useState<{ count: number; examples: { id: string; reason: string }[]; truncated: boolean }>({ count: 0, examples: [], truncated: false });

  const reload = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    const [rows, accts, at, err, quar, quarCount, quarTrunc] = await Promise.all([
      store.allTxns(),
      store.allAccounts(),
      store.getMeta('last_sync_at'),
      store.getMeta('last_sync_error'),
      store.getMeta('quarantined_records'),
      store.getMeta('quarantined_count'),
      store.getMeta('quarantined_truncated'),
    ]);
    setTxns(rows);
    setAccounts(new Map(accts.map((a) => [a.id, a])));
    setLastSyncAt(at || null);
    setLastSyncError(err || null);
    try {
      const examples = quar ? JSON.parse(quar) : [];
      const n = quarCount != null && quarCount !== '' ? Number(quarCount) : NaN;
      setQuarantined({ count: Number.isFinite(n) ? n : examples.length, examples: Array.isArray(examples) ? examples : [], truncated: quarTrunc === '1' });
    } catch {
      setQuarantined({ count: 0, examples: [], truncated: false });
    }
  }, []);

  const refresh = useCallback(async (): Promise<SyncResult> => {
    const engine = engineRef.current;
    if (!engine) return { ok: false, phase: 'none', total: 0, error: 'not ready' };
    setSyncing(true);
    setSyncProgress('Starting sync\u2026');
    try {
      let r = await engine.sync();
      if (r.needsServerSwitchConfirm) setServerSwitchPending(r.needsServerSwitchConfirm);
      if (r.ok && r.phase === 'full') {
        // A full sync leaves the changes feed unconsumed - apply it right away
        // so totals reflect the latest truth, not the full-list snapshot.
        r = await engine.sync();
        if (r.needsServerSwitchConfirm) setServerSwitchPending(r.needsServerSwitchConfirm);
      }
      await reload();
      return r;
    } finally {
      setSyncing(false);
      setSyncProgress('');
    }
  }, [reload]);

  useEffect(() => {
    (async () => {
      const store = await openStore();
      storeRef.current = store;
      const savedUrl = await store.getMeta(META_SERVER_URL);
      const url = savedUrl || DEFAULT_BASE_URL;
      setServerUrlState(url);
      engineRef.current = new SyncEngine(store, {
        baseUrl: url,
        onWait: (reason) => setSyncProgress(`Server busy (${reason}), waiting\u2026`),
      });
      await reload();
      setReady(true);
      // First launch: sync immediately, showing a live progress line.
      const tick = setInterval(async () => {
        const n = await store.count();
        setSyncProgress(`Loading history\u2026 ${n.toLocaleString('en-IN')} transactions`);
      }, 400);
      setSyncing(true);
      try {
        const r = await engineRef.current!.sync();
        // A first-launch 410 (server changed while the app was away, or
        // pre-stamp history) must surface the same ask as a manual sync.
        if (r.needsServerSwitchConfirm) setServerSwitchPending(r.needsServerSwitchConfirm);
        if (r.ok && r.phase === 'full') {
          const r2 = await engineRef.current!.sync();
          if (r2.needsServerSwitchConfirm) setServerSwitchPending(r2.needsServerSwitchConfirm);
        }
      } catch { /* error surfaces via last_sync_error */ } finally {
        clearInterval(tick);
        setSyncing(false);
        setSyncProgress('');
      }
      await reload();
    })().catch((e) => {
      setLastSyncError(String(e));
      setReady(true);
    });
  }, [reload]);

  const setServerUrl = useCallback(async (url: string) => {
    const store = storeRef.current;
    if (store) await store.commit({ meta: { [META_SERVER_URL]: url } });
    setServerUrlState(url);
    if (store) {
      engineRef.current = new SyncEngine(store, { baseUrl: url });
    }
  }, []);

  const confirmServerSwitch = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    setSyncing(true);
    setSyncProgress('Replacing local history\u2026');
    try {
      await engine.replaceWithServer({
        onProgress: (p) => setSyncProgress(`Downloading new server's history\u2026 ${p.synced.toLocaleString('en-IN')} transactions`),
      });
      setServerSwitchPending(null);
      await reload();
    } finally {
      setSyncing(false);
      setSyncProgress('');
    }
  }, [reload]);

  const dismissServerSwitch = useCallback(async () => {
    const previous = serverSwitchPending;
    setServerSwitchPending(null);
    if (previous?.previousUrl) await setServerUrl(previous.previousUrl);
    await reload();
  }, [serverSwitchPending, setServerUrl, reload]);

  const months = useMemo(() => computeMonthTotals(txns), [txns]);

  const value: AppState = {
    ready, txns, accounts, months, syncing, syncProgress,
    lastSyncAt, lastSyncError, quarantined, serverUrl, setServerUrl, refresh, reload,
    serverSwitchPending, confirmServerSwitch, dismissServerSwitch,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
