// Uses the Cortico panel context; no global DOM, dependencies or write actions.
export default {
  panels: {
    status: {
      mount(ctx) {
        const ui = ctx.ui;
        const sheet = ui.sheet({ title: 'Codex 任务通道', en: 'READ ONLY', desc: '用户输入、过程说明与最终答复，以外部来源进入 Cortico。' });
        const controls = ui.rowbar();
        const message = ui.msgline('正在读取桥接状态…');
        const body = ui.h('div');
        let loading = false;
        let lastCounts = '';
        const refresh = async () => {
          if (loading || ctx.signal.aborted) return;
          loading = true;
          try {
            const s = await ctx.invoke('snapshot');
            if (ctx.signal.aborted) return;
            message.textContent = s.currentError ? `需要检查：${s.currentError}` : s.running ? `通道运行中 · 每 ${s.watchIntervalSeconds} 秒检查新记录` : '通道已停止';
            message.classList.toggle('bad', !!s.currentError);
            body.replaceChildren(
              ui.statgrid([{ k: '可见任务', v: s.threads }, { k: '已保存通知', v: s.pushedEvents ?? 0, accent: true }, { k: '公开条目', v: s.pushedItems ?? 0 }, { k: '累计故障', v: s.failures ?? 0 }]),
              ui.section('运行证据'),
              ui.kv([{ k: '最近检查', v: s.lastPollAt ?? '等待首次检查' }, { k: '最近成功', v: s.lastSuccessAt ?? '暂无' }, { k: '待投递批次', v: s.pendingDeliveries ?? 0 }, { k: '仍待追赶任务', v: s.behindThreads ?? 0 }, { k: '最近故障', v: s.lastError ? `${s.lastError.at} · ${s.lastError.message}` : '暂无' }]),
              ui.section('读取范围'),
              ui.kv([{ k: '允许的工作区', v: s.allowedWorkspaces.join('\n') }, { k: '排除的工作区', v: s.deniedWorkspaces.join('\n') }, { k: '桥接日志', v: s.logDir ?? '暂无' }]),
              ui.msgline(s.discoveryWarnings?.length ? `来源覆盖警告：${s.discoveryWarnings.join('；')}` : '此面板仅观察任务记录；通知回执表示 Cortico 已保存事件。运行稳定性需结合观察窗口内的日志判断。', !!s.discoveryWarnings?.length)
            );
            const counts = `${s.threads}:${s.pushedEvents}:${s.failures}`;
            if (counts !== lastCounts) { await ctx.refresh(); lastCounts = counts; }
          } catch (error) {
            if (!ctx.signal.aborted) { message.textContent = `状态读取失败：${error instanceof Error ? error.message : String(error)}`; message.classList.add('bad'); }
          } finally { loading = false; }
        };
        controls.append(ui.button('刷新状态', { onClick: () => { void refresh(); } }), ui.pill('外部来源', 'plain'));
        sheet.body.append(controls, message, body);ctx.root.append(sheet.el);
        void refresh();ctx.interval(() => { void refresh(); }, 5000);
      }
    }
  }
};
