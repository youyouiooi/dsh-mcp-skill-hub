window.__ModuleLoader__.load({
  id: 'dsh-mcp-skill-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'dsh-mcp-skill-hub';

    function localeId(ctx) {
      try {
        const service = ctx.get('locale');
        const snapshot = service?.getSnapshot?.() ?? service?.getLocale?.();
        const id = typeof snapshot === 'string' ? snapshot : snapshot?.id ?? snapshot?.locale;
        if (id) return String(id).toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
      } catch { /* locale is optional */ }
      return 'zh-CN';
    }
    function label(ctx) {
      return () => (localeId(ctx) === 'en' ? 'MCP & Skills' : 'MCP 与技能');
    }

    /** The host renders the whole row; we only supply the glyph. */
    function SidebarIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', 'aria-hidden': true, style: { display: 'block' },
      },
        h('path', { d: 'M6 2V4.5M10 2V4.5', strokeLinecap: 'round' }),
        h('path', {
          d: 'M3.5 4.5H12.5V8.25C12.5 10.7353 10.4853 12.75 8 12.75C5.51472 12.75 3.5 10.7353 3.5 8.25V4.5Z',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 12.75V14.5', strokeLinecap: 'round' }),
        h('path', { d: 'M6.4 7.2L7.6 8.4L9.9 5.9', strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function HubPanel(props) {
      const border = 'var(--color-border, rgba(127,127,127,0.25))';
      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 14px', borderBottom: `1px solid ${border}`, fontSize: 13, flex: '0 0 auto',
          },
        },
          h('span', { style: { fontWeight: 600 } }, props.title),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', {
              type: 'button',
              onClick: () => window.open(props.src, '_blank'),
              style: { fontSize: 12, cursor: 'pointer', background: 'none', border: `1px solid ${border}`, borderRadius: 6, padding: '2px 8px', color: 'inherit' },
            }, localeId(props.ctx) === 'en' ? 'Open in browser' : '在浏览器打开'),
            h('button', {
              type: 'button', 'aria-label': 'close panel', onClick: props.closePanel,
              style: { fontSize: 14, cursor: 'pointer', background: 'none', border: 'none', color: 'inherit', padding: '0 4px' },
            }, '✕'))),
        h('iframe', {
          src: props.src, title: props.title,
          style: { flex: 1, border: 0, width: '100%', minHeight: 0, background: 'white' },
        }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let mainReady = false;
        let panelListReady = false;
        let entryDispose = null;
        const title = label(ctx);
        const syncEntries = () => {
          if (mainReady && panelListReady && entryDispose === null) {
            entryDispose = ctx.slots.register({
              name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: title,
            }, SidebarIcon);
          }
        };
        const dropEntry = () => {
          if (entryDispose !== null) { entryDispose(); entryDispose = null; }
        };

        // main must be ready before the sidebar row, or selecting the row fails.
        ctx.slots.inject('main', () => {
          const disposeMain = ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: () => ({
              ctx,
              src: `/mcp-skill-hub/ui/?locale=${encodeURIComponent(localeId(ctx))}`,
              title: title(),
              closePanel: () => ctx.get('layout')?.selectPanel?.(null),
            }),
          }, HubPanel);
          mainReady = true;
          syncEntries();
          return () => {
            mainReady = false;
            try {
              const layout = ctx.get('layout');
              if (layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID) layout.selectPanel(null);
            } catch { /* best effort */ }
            dropEntry();
            disposeMain();
          };
        });
        ctx.slots.inject('sidebar.panellist', () => {
          panelListReady = true;
          syncEntries();
          return () => { panelListReady = false; dropEntry(); };
        });
      },
    };
  },
});
