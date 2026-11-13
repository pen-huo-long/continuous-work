window.__ModuleLoader__.load({
  id: '@local/continuous-work',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const ACTIVE_PHASES = ['armed', 'running', 'waiting', 'retrying'];
    const en = {
      title: 'Continuous work', triggerTitle: 'Continuous work', enable: 'Enable recovery', stop: 'Stop', save: 'Save limits',
      retryNow: 'Retry now', retryRequested: 'Retrying the original step', processing: 'Processing…',
      manualRetryHint: 'After restoring quota manually, retry the original step immediately.',
      restartRequired: 'The backend plugin is still an older version. Restart Harness to load this feature; refreshing the page is not enough.',
      checkingBackend: 'Checking backend…', capabilityError: 'Could not check backend capabilities. Reopen this panel to retry.',
      off: 'Off', armed: 'Ready', running: 'Working', waiting: 'Waiting for quota',
      retrying: 'Retrying', stopped: 'Stopped', expired: 'Time limit reached',
      exhausted: 'Recovery budget reached', interrupted: 'Interrupted',
      loading: 'Loading…', unavailable: 'Recovery command unavailable', close: 'Close details',
      state: 'Status', progress: 'Quota windows', window: '{current} / {max}',
      recovered: '{count} successful recoveries', probes: 'Retries this recovery',
      started: 'Started', deadline: 'Deadline', until: 'Next attempt', remaining: 'Time remaining',
      duration: '{hours}h {minutes}m {seconds}s', none: '—', settings: 'Recovery limits',
      windows: 'Total quota windows', hours: 'Total time limit (hours)',
      bounds: 'Custom values · no fixed upper limit', info: 'Back', settingsTitle: 'Settings', saveEnable: 'Save and enable',
      monitoring: 'Monitoring quota. Recovery details appear when a quota limit is reached.',
      inactive: 'Quota recovery is off. Enable it to wait and retry after a quota limit.',
      waitRemaining: 'Next attempt in', noLimit: 'Enter a positive value; no fixed upper limit.',
      windowHelp: 'A window counts a successful quota recovery, not a conversation turn. The current window counts toward the limit.',
      timeHelp: 'The total time includes waits and is measured from the original start. Saving keeps the current progress and retry count.',
      idleHelp: 'Enable for this session. Quota failures wait and retry the original step. Keep Harness and the computer running.',
      saved: 'Limits saved', enabled: 'Quota recovery enabled', stoppedNotice: 'Recovery stopped', saving: 'Saving…',
      invalidWindows: 'Enter a positive integer of at least {min}.', invalidHours: 'Enter a positive, finite number of hours.', invalidDeadline: 'The resulting deadline cannot be represented as a valid date.',
      pastDeadline: 'The new deadline must be in the future.', unchanged: 'Current limits',
      elapsed: 'Elapsed time', stopHelp: 'Stopping also cancels the current execution.',
      resumeHelp: 'Enable again to start a new recovery budget.',
    };
    const zh = {
      title: '连续工作', triggerTitle: 'Continuous work', enable: '启用托管', stop: '停止', save: '保存上限',
      retryNow: '立即重试', retryRequested: '正在重试原步骤', processing: '处理中…',
      manualRetryHint: '手动恢复额度后，可立即重试原步骤。',
      restartRequired: '后台插件仍为旧版本，请重启 Harness 以加载此功能；仅刷新页面不会更新后台。',
      checkingBackend: '正在核对后台…', capabilityError: '无法读取后台功能，请重新打开面板重试。',
      off: '未启用', armed: '已就绪', running: '工作中', waiting: '等待额度恢复',
      retrying: '重试中', stopped: '已停止', expired: '已到运行时限',
      exhausted: '已到恢复上限', interrupted: '已中断',
      loading: '读取中…', unavailable: '托管命令不可用', close: '关闭详情',
      state: '运行状态', progress: '额度窗口', window: '{current} / {max}',
      recovered: '已成功恢复 {count} 次', probes: '本次恢复重试',
      started: '开始时间', deadline: '运行截止', until: '下次尝试', remaining: '剩余时长',
      duration: '{hours}时 {minutes}分 {seconds}秒', none: '—', settings: '托管上限',
      windows: '额度窗口总数', hours: '总运行时限（小时）',
      bounds: '自定义数值 · 无固定上限', info: '返回', settingsTitle: '设置', saveEnable: '保存并启用',
      monitoring: '正在监测额度，触发限额时显示恢复详情。',
      inactive: '启用后将在额度受限时等待恢复，并重试原步骤。',
      waitRemaining: '距下次尝试', noLimit: '输入正数，无固定上限。',
      windowHelp: '窗口按额度受限后成功恢复计数，与对话轮次无关；上限包含当前窗口。',
      timeHelp: '时限包含等待，从本次托管开始计算。保存后保留当前进度与重试计数。',
      idleHelp: '仅对当前会话启用。额度受限后等待恢复并重试原步骤，请保持 Harness 和机器运行。',
      saved: '上限已保存', enabled: '已启用额度托管', stoppedNotice: '已停止执行', saving: '保存中…',
      invalidWindows: '请输入不小于 {min} 的正整数。', invalidHours: '请输入大于 0 的有限小时数。', invalidDeadline: '该时限超出了可表示的日期范围。',
      pastDeadline: '调整后的截止时间须晚于当前时间。', unchanged: '当前上限',
      elapsed: '已用时长', stopHelp: '停止托管会同时取消当前执行。',
      resumeHelp: '重新启用将开始一次新的托管。',
    };
    const css = `
      .cw-root { display:inline-flex; flex:none; align-items:center; }
      .cw-trigger { display:inline-flex; align-items:center; justify-content:center; gap:6px; flex:none; font:inherit; font-size:var(--dsh-content-font-size-secondary,13px); font-variant-numeric:tabular-nums; line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px)); white-space:nowrap; padding:1px 8px; border:0; border-radius:var(--dsw-radius-sm); background:transparent; color:var(--dsw-alias-label-tertiary); cursor:pointer; }
      .cw-trigger[aria-expanded="true"] { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-secondary); }
      @media (hover:hover) { .cw-trigger:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-secondary); } }
      .cw-trigger:focus-visible, .cw-panel button:focus-visible, .cw-panel input:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
      .cw-icon { display:block; flex:none; }
      .cw-tone-idle { color:var(--dsw-alias-state-idle-primary); }
      .cw-tone-ready { color:var(--dsw-alias-state-success-primary); }
      .cw-tone-running { color:var(--dsw-alias-brand-primary); }
      .cw-tone-waiting { color:var(--dsw-alias-state-warn-primary); }
      .cw-tone-ended { color:var(--dsw-alias-state-error-primary); }
      .cw-orbit { transform-origin:9px 9px; animation:cw-spin 3s linear infinite; }
      @keyframes cw-spin { to { transform:rotate(360deg); } }
      @media (prefers-reduced-motion:reduce) { .cw-orbit { animation:none; } }
      .cw-panel { z-index:1100; box-sizing:border-box; position:fixed; width:max-content; min-width:min(300px,100vw - 24px); max-width:min(440px,100vw - 24px); max-height:calc(100dvh - 12px - max(12px,var(--dsh-frame-overlay-top,12px))); overflow:hidden auto; border:0; border-radius:var(--dsw-radius-lg); background:var(--dsw-specific-menu); backdrop-filter:var(--dsw-menu-backdrop-filter); --dsw-elevation-stroke-color:var(--dsw-alias-border-l1); box-shadow:var(--dsw-elevation-prominent); color:var(--dsw-alias-label-secondary); cursor:default; margin:0; padding:16px; font-family:inherit; font-size:12px; line-height:18px; text-align:left; --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2); }
      .cw-panel *, .cw-panel *::before, .cw-panel *::after { box-sizing:border-box; }
      .cw-header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:8px; color:var(--dsw-alias-label-primary); font-weight:500; }
      .cw-title-rule { border-top:.5px solid var(--dsw-alias-border-l2); margin-bottom:10px; }
      .cw-title-label { display:inline-flex; align-items:center; gap:6px; flex:1; min-width:0; }
      .cw-title-label > .cw-icon { width:14px; height:14px; }
      .cw-header h2 { flex:1; min-width:0; margin:0; font-size:12px; font-weight:500; color:var(--dsw-alias-label-primary); }
      .cw-panel button { font:inherit; cursor:pointer; }
      .cw-close { display:flex; flex:none; align-items:center; justify-content:center; width:24px; height:24px; border:0; padding:4px; border-radius:var(--dsw-radius-sm); background:transparent; color:var(--dsw-alias-label-tertiary); }
      .cw-close:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-secondary); }
      .cw-status { display:flex; align-items:center; justify-content:space-between; gap:16px; color:var(--dsw-alias-label-tertiary); }
      .cw-status-value { display:flex; align-items:center; gap:6px; font-weight:500; }
      .cw-progress { margin-top:10px; }
      .cw-progress-heading { display:flex; justify-content:space-between; gap:16px; color:var(--dsw-alias-label-tertiary); }
      .cw-progress-heading strong { font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-primary); font-weight:500; }
      .cw-track { height:4px; margin:7px 0 5px; border-radius:3px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
      .cw-track-fill { display:block; height:100%; background:var(--dsw-alias-brand-primary); }
      .cw-note { margin:6px 0 0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
      .cw-metrics { display:grid; grid-template-columns:minmax(76px,auto) minmax(0,1fr); gap:6px 16px; margin:10px 0 0; padding:0; color:var(--dsw-alias-label-tertiary); }
      .cw-metric { display:contents; }
      .cw-metric dt, .cw-metric dd { min-width:0; margin:0; }
      .cw-metric dd { color:var(--dsw-alias-label-secondary); text-align:right; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
      .cw-form { margin:0; }
      .cw-page-link { display:inline-flex; align-items:center; gap:4px; padding:2px 6px; border:0; border-radius:var(--dsw-radius-sm); background:transparent; color:var(--dsw-alias-label-secondary); }
      .cw-page-link:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .cw-info-note { margin:12px 0; }
      .cw-settings-summary { border-top:1px solid var(--dsw-alias-border-l1); margin-top:12px; padding-top:6px; }
      .cw-settings-heading { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:10px; }
      .cw-settings-heading strong { font-weight:500; color:var(--dsw-alias-label-primary); }
      .cw-settings-heading small { font-size:11px; }
      .cw-fields { display:grid; grid-template-columns:1fr; gap:12px; }
      .cw-field { display:flex; flex-direction:column; gap:5px; }
      .cw-field input { width:100%; min-width:0; height:32px; padding:5px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-variant-numeric:tabular-nums; }
      .cw-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:12px; }
      .cw-action { border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-sm); padding:5px 10px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
      .cw-action:hover { background:var(--dsw-alias-bg-layer-2); }
      .cw-action-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); }
      .cw-action-primary:hover { background:var(--dsw-alias-brand-primary); filter:brightness(.95); }
      .cw-action-stop { margin-right:auto; color:var(--dsw-alias-state-error-primary); }
      .cw-panel button:disabled, .cw-panel input:disabled { opacity:.5; cursor:default; }
      .cw-feedback { margin:8px 0 0; font-size:12px; line-height:18px; }
      .cw-error { color:var(--dsw-alias-state-error-primary); }
      .cw-success { color:var(--dsw-alias-state-success-primary); }
    `;
    function tone(phase) {
      if (phase === 'armed') return 'ready';
      if (['running', 'retrying'].includes(phase)) return 'running';
      if (phase === 'waiting') return 'waiting';
      if (['expired', 'exhausted', 'interrupted'].includes(phase)) return 'ended';
      return 'idle';
    }
    function StatusIcon({ phase }) {
      const spinning = ['running', 'retrying', 'loading'].includes(phase);
      const center = phase === 'waiting' ? h('path', { d: 'M7 6.5h4M7 11.5h4M7 6.5c0 2 4 3 4 5M11 6.5c0 2-4 3-4 5' }) :
        phase === 'armed' || spinning ? h('path', { d: 'm8 6.5 3.5 2.5L8 11.5Z', fill: 'currentColor', stroke: 'none' }) :
        ['expired', 'exhausted', 'interrupted'].includes(phase) ? h('path', { d: 'M9 5.8v4M9 12v.2' }) :
        h('path', { d: 'M6.5 9h5' });
      return h('svg', { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round', className: `cw-icon cw-tone-${tone(phase)}`, 'aria-hidden': true },
      h('circle', { cx: 9, cy: 9, r: 7, opacity: .3 }),
      h('path', { d: 'M9 2a7 7 0 0 1 7 7', className: spinning ? 'cw-orbit' : undefined }), center);
    }
    function Panel(props) {
      // A Session switch owns a fresh form and dismisses the previous Session's details.
      return h(Control, { ...props, key: props.sessionId });
    }
    function Control({ useProjection, useSession, getCapabilities, onAction, t }) {
      const projection = useProjection('codexContinuity');
      const sessionRunning = useSession((snapshot) => snapshot.running) ?? false;
      const run = projection?.run;
      const [open, setOpen] = React.useState(false);
      const [page, setPage] = React.useState('info');
      const [clock, setClock] = React.useState(Date.now);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [backend, setBackend] = React.useState(null);
      const [windows, setWindows] = React.useState('3');
      const [hours, setHours] = React.useState('18');
      const [position, setPosition] = React.useState(null);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const headerActionRef = React.useRef(null);
      const pageHeadingRef = React.useRef(null);
      const pending = React.useRef(false);
      const mounted = React.useRef(true);
      const dialogId = `cw-${React.useId().replaceAll(':', '')}`;
      const active = run && clock < run.deadlineAt && ACTIVE_PHASES.includes(run.phase);
      const phase = projection === undefined ? 'loading' : !run ? 'off' :
        ACTIVE_PHASES.includes(run.phase) && clock >= run.deadlineAt ? 'expired' :
          active && !['waiting', 'retrying'].includes(run.phase) ? (sessionRunning ? 'running' : 'armed') : run.phase;
      const recovering = !!(active && sessionRunning && run.pendingRecovery && ['waiting', 'retrying'].includes(run.phase));
      const waiting = recovering && run.phase === 'waiting' && run.nextRetryAt != null;
      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);
      React.useEffect(() => {
        if (!open) return;
        let disposed = false;
        setBackend(null);
        getCapabilities().then((capabilities) => {
          if (!disposed) setBackend(capabilities);
        }, () => {
          if (!disposed) setBackend({ retry: false, update: false, error: true });
        });
        return () => { disposed = true; };
      }, [open, getCapabilities]);
      React.useEffect(() => {
        setWindows(String(run?.maxWindows ?? 3));
        setHours(String(run ? (run.deadlineAt - run.startedAt) / 3_600_000 : 18));
      }, [run?.id, run?.maxWindows, run?.startedAt, run?.deadlineAt]);
      React.useEffect(() => {
        setClock(Date.now());
        if (!run || !ACTIVE_PHASES.includes(run.phase)) return;
        const timer = setInterval(() => setClock(Date.now()), open && page === 'info' && waiting ? 1000 : 30_000);
        return () => clearInterval(timer);
      }, [run?.id, run?.phase, run?.deadlineAt, open, page, waiting]);
      function dismiss(restoreFocus) {
        setOpen(false);
        if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
      }
      React.useLayoutEffect(() => {
        if (!open) return;
        const trigger = triggerRef.current;
        const panel = panelRef.current;
        if (!trigger || !panel) return;
        const place = () => {
          const rect = trigger.getBoundingClientRect();
          const viewportHeight = window.innerHeight;
          const maxHeight = Math.max(0, viewportHeight - 24);
          const height = Math.min(panel.getBoundingClientRect().height, maxHeight);
          const left = Math.max(12, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 12));
          const top = rect.top - height - 8 >= 12 ? rect.top - height - 8 :
            Math.min(Math.max(12, rect.bottom + 8), Math.max(12, viewportHeight - height - 12));
          setPosition((old) => old?.top === top && old?.left === left && old?.maxHeight === maxHeight ? old : { top, left, maxHeight });
        };
        place();
        const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
        resize?.observe(trigger);
        resize?.observe(panel);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          resize?.disconnect();
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [open]);
      React.useEffect(() => {
        if (open && position !== null) headerActionRef.current?.focus({ preventScroll: true });
      }, [open, position !== null]);
      React.useEffect(() => {
        if (open) pageHeadingRef.current?.focus({ preventScroll: true });
      }, [page]);
      React.useEffect(() => {
        if (!open) return;
        const outside = (event) => {
          if (!rootRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
        };
        const escape = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          dismiss(true);
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('focusin', outside);
        document.addEventListener('keydown', escape, true);
        return () => {
          document.removeEventListener('pointerdown', outside, true);
          document.removeEventListener('focusin', outside);
          document.removeEventListener('keydown', escape, true);
        };
      }, [open]);
      async function act(action, successKey) {
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setError('');
        setNotice('');
        try {
          await onAction(action);
          if (mounted.current) setNotice(t(successKey));
        } catch (err) {
          if (mounted.current) setError(err instanceof Error ? err.message : String(err));
        } finally {
          pending.current = false;
          if (mounted.current) setBusy(false);
        }
      }
      const minWindows = active ? run.window + (run.pendingRecovery ? 1 : 0) : 1;
      const windowsValue = Number(windows);
      const hoursValue = Number(hours);
      const candidateStart = active ? run.startedAt : clock;
      const candidateDeadline = Math.ceil(candidateStart + hoursValue * 3_600_000);
      const startParameters = run ? `${run.maxWindows} ${(run.deadlineAt - run.startedAt) / 3_600_000}` : '3 18';
      const validation = !Number.isSafeInteger(windowsValue) || windowsValue < minWindows ?
        t('invalidWindows', { min: minWindows }) : !Number.isFinite(hoursValue) || hoursValue <= 0 ? t('invalidHours') :
          !Number.isSafeInteger(candidateDeadline) || candidateDeadline <= candidateStart || !Number.isFinite(new Date(candidateDeadline).getTime()) ? t('invalidDeadline') :
            active && candidateDeadline <= clock ? t('pastDeadline') : '';
      const changed = !active || windowsValue !== run.maxWindows || candidateDeadline !== run.deadlineAt;
      const time = (value) => value == null ? t('none') : new Date(value).toLocaleString();
      const duration = (value) => {
        const seconds = Math.max(0, Math.ceil(value / 1000));
        return t('duration', { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds / 60) % 60, seconds: seconds % 60 });
      };
      function metric(label, value) {
        return h('div', { className: 'cw-metric', key: label }, h('dt', null, t(label)), h('dd', null, value));
      }
      function change(setter, value) {
        setter(value);
        setError('');
        setNotice('');
      }
      const statusLabel = `${t('triggerTitle')} · ${t(phase)}`;
      function switchPage(nextPage) {
        setPage(nextPage);
        setError('');
        setNotice('');
      }
      const settingsPage = page === 'settings';
      const details = open && h('section', { ref: panelRef, id: dialogId, className: 'cw-panel', role: 'dialog',
        'aria-labelledby': `${dialogId}-title`, style: { ...position, visibility: position ? 'visible' : 'hidden' },
        onPointerDown: (event) => event.stopPropagation() },
      h('header', { className: 'cw-header' },
        h('div', { className: 'cw-title-label' },
        settingsPage ? h('button', { type: 'button', className: 'cw-page-link', onClick: () => switchPage('info') },
          h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
            h('path', { d: 'm8 3-4 4 4 4' })), t('info')) : h(StatusIcon, { phase }),
        h('h2', { id: `${dialogId}-title`, ref: pageHeadingRef, tabIndex: -1 }, t(settingsPage ? 'settingsTitle' : 'title'))),
        !settingsPage && h('button', { ref: headerActionRef, type: 'button', className: 'cw-close',
          'aria-label': t('settingsTitle'), onClick: () => switchPage('settings') },
          h('svg', { width: 16, height: 16, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round', 'aria-hidden': true },
            h('path', { d: 'M5.8 1h2.4l.4 1.7 1 .6 1.7-.5 1.2 2.1L11.2 6v1.2l1.3 1.1-1.2 2.1-1.7-.5-1 .6-.4 1.7H5.8l-.4-1.7-1-.6-1.7.5-1.2-2.1 1.3-1.1V6L1.5 4.9l1.2-2.1 1.7.5 1-.6Z' }),
            h('circle', { cx: 7, cy: 6.6, r: 2 }))),
        settingsPage && h('button', { ref: headerActionRef, type: 'button', className: 'cw-close', 'aria-label': t('close'), onClick: () => dismiss(true) },
          h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
            h('path', { d: 'm3 3 8 8M11 3l-8 8' })))),
      h('div', { className: 'cw-title-rule', 'aria-hidden': true }),
      !settingsPage && h(React.Fragment, null,
        h('div', { className: 'cw-status' }, h('span', null, t('state')),
          h('span', { className: `cw-status-value cw-tone-${tone(phase)}`, role: 'status' }, t(phase))),
        recovering ? h(React.Fragment, null,
          h('div', { className: 'cw-progress' },
            h('div', { className: 'cw-progress-heading' }, h('span', null, t('progress')),
              h('strong', null, t('window', { current: run.window, max: run.maxWindows }))),
            h('div', { className: 'cw-track', 'aria-hidden': true },
              h('span', { className: 'cw-track-fill', style: { width: `${Math.min(100, run.window / run.maxWindows * 100)}%` } })),
            h('p', { className: 'cw-note' }, t('recovered', { count: Math.max(0, run.window - 1) }))),
          h('dl', { className: 'cw-metrics' }, metric('probes', `${run.attempts} / 48`),
            waiting && metric('waitRemaining', duration(run.nextRetryAt - clock)),
            waiting && metric('until', time(run.nextRetryAt)))) :
          h('p', { className: 'cw-note cw-info-note' }, t(active ? 'monitoring' : 'inactive')),
        h('div', { className: 'cw-actions' },
          active ? h('button', { type: 'button', className: 'cw-action cw-action-stop', disabled: busy,
            onClick: () => act('stop', 'stoppedNotice') }, t('stop')) :
            h('button', { type: 'button', className: 'cw-action cw-action-primary', disabled: busy || projection === undefined,
              onClick: () => act(`start ${startParameters}`, 'enabled') }, t('enable')),
          waiting && h('button', { type: 'button', className: 'cw-action cw-action-primary', disabled: busy || !backend?.retry,
            onClick: () => act('retry', 'retryRequested') }, t(backend === null ? 'checkingBackend' : busy ? 'processing' : 'retryNow'))),
        waiting && backend?.retry && h('p', { className: 'cw-note' }, t('manualRetryHint'))),
      settingsPage && h('form', { className: 'cw-form', 'aria-busy': busy, onSubmit: (event) => {
        event.preventDefault();
        if (validation || !changed || projection === undefined || !backend?.update) return;
        act(`${active ? 'update' : 'start'} ${windowsValue} ${hoursValue}`, active ? 'saved' : 'enabled');
      } },
        h('div', { className: 'cw-settings-heading' }, h('strong', null, t('settings')), h('small', null, t('bounds'))),
        h('div', { className: 'cw-fields' },
          h('label', { className: 'cw-field' }, t('windows'), h('input', { type: 'number', value: windows, min: minWindows, step: 1,
            disabled: busy || projection === undefined || !backend?.update, 'aria-describedby': `${dialogId}-window-help`,
            onChange: (event) => change(setWindows, event.target.value) })),
          h('label', { className: 'cw-field' }, t('hours'), h('input', { type: 'number', value: hours, min: 0, step: 'any',
            disabled: busy || projection === undefined || !backend?.update, 'aria-describedby': `${dialogId}-time-help`,
            onChange: (event) => change(setHours, event.target.value) }))),
        h('p', { className: 'cw-note', id: `${dialogId}-window-help` }, t('windowHelp')),
        h('p', { className: 'cw-note', id: `${dialogId}-time-help` }, t(active ? 'timeHelp' : 'idleHelp')),
        active && h('dl', { className: 'cw-metrics cw-settings-summary' },
          metric('started', time(run.startedAt)), metric('deadline', time(run.deadlineAt))),
        h('div', { className: 'cw-actions' },
          h('button', { type: 'submit', className: 'cw-action cw-action-primary', disabled: busy || projection === undefined || !backend?.update || !!validation || !changed },
            t(busy ? 'saving' : active ? 'save' : 'saveEnable'))),
        validation && h('p', { className: 'cw-feedback cw-error', role: 'status' }, validation)),
      backend?.error && h('p', { className: 'cw-feedback cw-error', role: 'alert' }, t('capabilityError')),
      !backend?.error && (waiting && backend?.retry === false || settingsPage && backend?.update === false) &&
        h('p', { className: 'cw-feedback cw-error', role: 'status' }, t('restartRequired')),
      error && h('p', { className: 'cw-feedback cw-error', role: 'alert' }, error),
      notice && h('p', { className: 'cw-feedback cw-success', role: 'status' }, notice));
      return h('span', { className: 'cw-root', ref: rootRef },
        h('style', null, css),
        h('button', { ref: triggerRef, type: 'button', className: 'cw-trigger',
          'aria-label': statusLabel, 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? dialogId : undefined,
          onClick: () => { setPosition(null); setClock(Date.now()); setPage('info'); setOpen((value) => !value); } }, h(StatusIcon, { phase }), h('span', null, t('triggerTitle'))),
        details && createPortal(details, document.body));
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        const commands = ctx.remote.commands;
        async function getCapabilities(sessionId) {
          const result = await commands.list(sessionId);
          if (!result.ok) throw new Error(result.error.message);
          const command = result.value.find((entry) => entry.name === 'codex-work');
          const actions = new Set((command?.input?.hint ?? '').split('|').map((part) => part.trim().split(/\s+/u)[0]));
          return { retry: actions.has('retry'), update: actions.has('update') };
        }
        ctx.effect(() => ctx.locale.register('codexContinuity', 'en', en));
        ctx.effect(() => ctx.locale.register('codexContinuity', 'zh', zh));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'continuous-work', order: 8,
          locale: 'codexContinuity',
          inject: (sessionId) => ({
            getCapabilities: () => getCapabilities(sessionId),
            onAction: async (action) => {
              const operation = action.split(/\s+/u)[0];
              if (operation === 'retry' || operation === 'update') {
                const capabilities = await getCapabilities(sessionId);
                if (!capabilities[operation]) throw new Error(ctx.locale.bind('codexContinuity')('restartRequired'));
              }
              const result = await commands.execute(sessionId, `/codex-work ${action}`, []);
              if (!result.ok) throw new Error(result.error.message);
              if (!result.value) throw new Error(ctx.locale.bind('codexContinuity')('unavailable'));
              if (result.value.result.kind === 'error') throw new Error(result.value.result.text);
            },
          }),
        }, Panel));
      },
    };
  },
});
