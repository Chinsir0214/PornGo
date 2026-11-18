(() => {
  'use strict';

  const api = window.porngo;
  const elements = {
    appHeader: document.querySelector('.app-header'),
    mainColumn: document.querySelector('.main-column'),
    windowMinimize: document.getElementById('window-minimize'),
    windowMaximize: document.getElementById('window-maximize'),
    windowClose: document.getElementById('window-close'),
    sessionPill: document.getElementById('session-pill'),
    sessionLabel: document.getElementById('session-label'),
    sessionSummary: document.getElementById('session-summary'),
    loginButton: document.getElementById('login-button'),
    loginHelp: document.getElementById('login-help'),
    logoutButton: document.getElementById('logout-button'),
    credentialsSave: document.getElementById('credentials-save'),
    credentialsFill: document.getElementById('credentials-fill'),
    credentialsDelete: document.getElementById('credentials-delete'),
    deleteCredentialsDialog: document.getElementById('delete-credentials-dialog'),
    deleteCredentialsCancel: document.getElementById('delete-credentials-cancel'),
    notice: document.getElementById('notice'),
    noticeMessage: document.getElementById('notice-message'),
    noticeClose: document.getElementById('notice-close'),
    parseForm: document.getElementById('parse-form'),
    urlInput: document.getElementById('video-url'),
    urlHelp: document.getElementById('url-help'),
    urlClear: document.getElementById('url-clear'),
    parseButton: document.getElementById('parse-button'),
    videoEmpty: document.getElementById('video-empty'),
    videoDetails: document.getElementById('video-details'),
    resourceKind: document.getElementById('resource-kind'),
    parsedTitle: document.getElementById('parsed-title'),
    videoMeta: document.getElementById('video-meta'),
    thumbnail: document.getElementById('video-thumbnail'),
    thumbnailPlaceholder: document.getElementById('thumbnail-placeholder'),
    formatRow: document.getElementById('format-row'),
    formatSelect: document.getElementById('format-select'),
    concurrencyCard: document.getElementById('concurrency-card'),
    fragmentConcurrency: document.getElementById('fragment-concurrency'),
    videoConcurrency: document.getElementById('video-concurrency'),
    directoryButton: document.getElementById('directory-button'),
    directoryPath: document.querySelector('.directory-path'),
    directoryLabel: document.getElementById('directory-label'),
    downloadButton: document.getElementById('download-button'),
    downloadLabel: document.getElementById('download-label'),
    progressEmpty: document.getElementById('progress-empty'),
    progressContent: document.getElementById('progress-content'),
    progressStatus: document.getElementById('progress-status'),
    progressPercent: document.getElementById('progress-percent'),
    progressTrack: document.getElementById('progress-track'),
    progressFill: document.getElementById('progress-fill'),
    progressItem: document.getElementById('progress-item'),
    progressVideos: document.getElementById('progress-videos'),
    progressDetail: document.getElementById('progress-detail'),
    queueStatus: document.getElementById('queue-status'),
    queueToggle: document.getElementById('queue-toggle'),
    queueList: document.getElementById('queue-list'),
    progressCard: document.querySelector('.progress-card'),
    cancelButton: document.getElementById('cancel-button'),
    failedDownloads: document.getElementById('failed-downloads'),
    failedBatches: document.getElementById('failed-batches'),
    clearSessionDialog: document.getElementById('clear-session-dialog'),
    clearSessionCancel: document.getElementById('clear-session-cancel')
  };

  let parsedResource = null;
  let concurrencyOptions = null;
  let batchVideoConcurrency = '';
  let directory = '';
  let directoryLoading = true;
  let selectingDirectory = false;
  let activeTaskId = null;
  let activeDownloadResource = null;
  const queuedTasks = [];
  const queueRows = new Map();
  const cancellingQueuedTasks = new Set();
  let queueExpanded = false;
  const failedBatches = new Map();
  const failedBatchRevisions = new Map();
  let submittingDownload = false;
  let parsing = false;
  let cancelling = false;
  let loginBusy = false;
  let loginWindowOpen = false;
  let loginWindowRevision = -1;
  let credentialsReady = false;
  let credentialsAvailable = false;
  let credentialsSaved = false;
  let credentialsUnreadable = false;
  let credentialsBusy = false;
  let credentialsRevision = 0;
  let parseGeneration = 0;
  let composingUrl = false;
  let pendingDownloadEvents = [];
  let sessionRevision = 0;
  let latestAuthRevision = -1;
  const kindNames = { video: '单视频', playlist: '片单', pornstar: '色情明星视频' };
  const concurrencySettingsKey = 'porngo.downloadConcurrency';
  const urlHelpText = '支持 Pornhub 视频、片单和明星视频页（HTTP/HTTPS）';

  function configureConcurrency(options) {
    const selectors = [
      [elements.fragmentConcurrency, options.fragment, '片'],
      [elements.videoConcurrency, options.video, '条'],
    ];
    let saved;
    try {
      saved = JSON.parse(window.localStorage.getItem(concurrencySettingsKey) || 'null');
    } catch {
      // Keep the default selections when storage is unavailable or invalid.
    }
    for (const [select, values, unit] of selectors) {
      for (const value of values) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `${value === 1 ? '顺序' : '并发'} · ${value} ${unit}`;
        select.append(option);
      }
    }
    concurrencyOptions = options;
    const fragment = options.fragment.map(String);
    const video = options.video.map(String);
    elements.fragmentConcurrency.value = fragment.includes(saved?.fragmentConcurrency)
      ? saved.fragmentConcurrency : fragment[0];
    batchVideoConcurrency = video.includes(saved?.videoConcurrency) ? saved.videoConcurrency : video[0];
    setVideoConcurrency();
    updateControls();
  }

  function setVideoConcurrency() {
    if (concurrencyOptions) {
      elements.videoConcurrency.value = parsedResource?.kind === 'video'
        ? String(concurrencyOptions.video[0]) : batchVideoConcurrency;
    }
  }

  function saveConcurrencySettings() {
    if (!concurrencyOptions) return;
    if (parsedResource && parsedResource.kind !== 'video') batchVideoConcurrency = elements.videoConcurrency.value;
    try {
      window.localStorage.setItem(concurrencySettingsKey, JSON.stringify({
        fragmentConcurrency: elements.fragmentConcurrency.value,
        videoConcurrency: batchVideoConcurrency,
      }));
    } catch {
      // Downloads still work if the browser cannot persist preferences.
    }
  }

  function renderQueue() {
    const count = queuedTasks.length;
    const status = `排队等待：${count} 个任务`;
    const queueIds = new Set(queuedTasks.map((task) => task.taskId));
    let lostFocusIndex = null;
    for (const [taskId, controls] of queueRows) {
      if (queueIds.has(taskId)) continue;
      if (document.activeElement === controls.remove) lostFocusIndex = controls.index;
      controls.row.remove();
      queueRows.delete(taskId);
    }
    if (count === 0) queueExpanded = false;
    elements.queueToggle.hidden = count === 0;
    if (elements.queueStatus.textContent !== status) elements.queueStatus.textContent = status;
    elements.queueToggle.setAttribute('aria-expanded', String(queueExpanded));
    elements.queueList.hidden = count === 0 || !queueExpanded;
    queuedTasks.forEach((task, index) => {
      let controls = queueRows.get(task.taskId);
      if (!controls) {
        const row = document.createElement('div');
        row.className = 'download-list-row queue-row';
        const title = document.createElement('span');
        title.className = 'text-ellipsis';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'button button-outline queue-row-remove';
        remove.addEventListener('click', () => removeQueuedTask(task.taskId));
        row.append(title, remove);
        elements.queueList.append(row);
        controls = { row, title, remove };
        queueRows.set(task.taskId, controls);
      }
      const { title, remove } = controls;
      controls.index = index;
      const resource = task.resource || {};
      const name = typeof resource.title === 'string' && resource.title.trim()
        ? resource.title : `下载任务 ${index + 1}`;
      const kind = kindNames[resource.kind] || '下载';
      title.textContent = `${index + 1}. ${kind} · ${name}`;
      const removing = cancellingQueuedTasks.has(task.taskId);
      remove.textContent = removing ? '移除中…' : '移除';
      remove.setAttribute('aria-disabled', String(removing));
      remove.setAttribute('aria-label', `${removing ? '正在从队列移除' : '从队列移除'}：${name}`);
    });
    if (lostFocusIndex !== null) {
      const next = queuedTasks[Math.min(lostFocusIndex, count - 1)];
      const target = next ? queueRows.get(next.taskId).remove
        : !elements.cancelButton.disabled ? elements.cancelButton : elements.progressStatus;
      target.focus();
    }
  }

  async function removeQueuedTask(taskId) {
    if (!api || cancellingQueuedTasks.has(taskId)
        || !queuedTasks.some((task) => task.taskId === taskId)) return;
    cancellingQueuedTasks.add(taskId);
    updateControls();
    try {
      const removed = await api.removeQueued(taskId);
      if (!removed && activeTaskId === taskId) showNotice('该任务已开始下载，无法从等待队列移除。');
    } catch (error) {
      showNotice(`移除排队任务失败：${errorMessage(error)}`, 'error');
    } finally {
      cancellingQueuedTasks.delete(taskId);
      updateControls();
    }
  }

  function setWindowState(state) {
    const maximized = Boolean(state && state.maximized);
    elements.windowMaximize.classList.toggle('is-maximized', maximized);
    elements.windowMaximize.setAttribute('aria-label', maximized ? '还原窗口' : '最大化窗口');
    elements.windowMaximize.title = maximized ? '还原' : '最大化';
  }

  if (api && typeof api.windowState === 'function') {
    api.windowState().then(setWindowState).catch(() => {});
    api.onWindowState(setWindowState);
    elements.windowMinimize.addEventListener('click', () => api.minimizeWindow());
    elements.windowMaximize.addEventListener('click', () => api.toggleMaximizeWindow().then(setWindowState));
    elements.windowClose.addEventListener('click', () => api.closeWindow());
    elements.appHeader.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, .header-actions, .window-controls')) return;
      api.toggleMaximizeWindow().then(setWindowState);
    });
  }

  function errorMessage(error) {
    if (error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
    }
    if (typeof error === 'string' && error.trim()) return error;
    return '操作失败，请稍后重试。';
  }

  function showNotice(message, kind = 'info') {
    elements.noticeMessage.textContent = String(message);
    elements.notice.dataset.kind = kind;
    elements.notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    elements.notice.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    elements.noticeClose.disabled = false;
    elements.notice.hidden = false;
  }

  function hideNotice() {
    elements.notice.hidden = true;
    elements.noticeMessage.textContent = '';
    elements.noticeClose.disabled = true;
  }

  function updateControls() {
    const hasUrl = Boolean(elements.urlInput.value.trim());
    const downloadWork = hasDownloadWork();
    elements.urlInput.disabled = false;
    elements.urlClear.hidden = !hasUrl;
    elements.urlClear.disabled = !hasUrl;
    elements.parseButton.disabled = !hasUrl || parsing;
    elements.parseButton.textContent = parsing ? '解析中…' : '解析链接';
    elements.parseButton.classList.toggle('is-busy', parsing);
    elements.parseButton.setAttribute('aria-busy', String(parsing));
    elements.directoryButton.disabled = directoryLoading || selectingDirectory;
    elements.formatSelect.disabled = false;
    elements.fragmentConcurrency.disabled = !concurrencyOptions;
    elements.videoConcurrency.disabled = !concurrencyOptions || !parsedResource || parsedResource.kind === 'video';
    elements.downloadButton.disabled = !concurrencyOptions || !parsedResource || !directory
      || !elements.formatSelect.value || parsing || submittingDownload;
    elements.downloadLabel.textContent = submittingDownload ? '正在加入…'
      : downloadWork ? '加入下载队列' : '开始下载';
    elements.downloadButton.classList.toggle('is-busy', submittingDownload);
    elements.downloadButton.setAttribute('aria-busy', String(submittingDownload));
    elements.cancelButton.disabled = !activeTaskId || cancelling;
    elements.cancelButton.textContent = cancelling ? '正在取消…' : '取消下载';
    elements.loginButton.disabled = loginBusy || downloadWork;
    elements.loginButton.textContent = loginBusy ? '正在打开…'
      : loginWindowOpen ? '显示登录窗口' : '内嵌网页登录';
    elements.loginButton.classList.toggle('is-busy', loginBusy);
    elements.loginButton.setAttribute('aria-busy', String(loginBusy));
    elements.logoutButton.disabled = loginBusy || downloadWork;
    const credentialsLocked = !credentialsReady || credentialsBusy || loginBusy || downloadWork;
    elements.credentialsSave.disabled = credentialsLocked || !credentialsAvailable || !loginWindowOpen;
    elements.credentialsSave.textContent = credentialsSaved ? '更新网页登录账号密码' : '保存网页登录账号密码';
    elements.credentialsSave.setAttribute('aria-busy', String(credentialsBusy));
    elements.credentialsFill.hidden = !credentialsSaved;
    elements.credentialsFill.disabled = credentialsLocked || !credentialsAvailable || credentialsUnreadable || !credentialsSaved || !loginWindowOpen;
    elements.credentialsDelete.hidden = !credentialsSaved;
    elements.credentialsDelete.disabled = credentialsLocked || !credentialsSaved;
    elements.progressCard.dataset.state = downloadWork ? 'running'
      : elements.progressContent.hidden ? 'idle' : 'finished';
    renderQueue();
    updateFailedControls();
  }

  function updateFailedControls() {
    for (const batch of failedBatches.values()) {
      if (!batch.controls) continue;
      const available = batch.items.filter((item) => !item.pending);
      const selected = available.filter((item) => batch.selected.has(item.itemIndex)).length;
      batch.controls.all.disabled = submittingDownload || available.length === 0;
      batch.controls.all.checked = available.length > 0 && selected === available.length;
      batch.controls.all.indeterminate = selected > 0 && selected < available.length;
      batch.controls.retry.disabled = submittingDownload || selected === 0;
      batch.controls.retry.textContent = selected > 0 ? `重新下载选中项（${selected}）` : '重新下载选中项';
      for (const { checkbox, item } of batch.controls.rows) checkbox.disabled = submittingDownload || item.pending;
    }
  }

  function applyFailedBatch(snapshot) {
    if (!snapshot || typeof snapshot.taskId !== 'string' || !Array.isArray(snapshot.items)) return;
    if (Number.isInteger(snapshot.revision)) {
      if (snapshot.revision <= (failedBatchRevisions.get(snapshot.taskId) || 0)) return;
      failedBatchRevisions.set(snapshot.taskId, snapshot.revision);
    }
    if (snapshot.items.length === 0) failedBatches.delete(snapshot.taskId);
    else {
      const previous = failedBatches.get(snapshot.taskId);
      const selected = previous ? previous.selected : new Set();
      for (const index of selected) {
        if (!snapshot.items.some((item) => item.itemIndex === index && !item.pending)) selected.delete(index);
      }
      failedBatches.set(snapshot.taskId, { ...snapshot, selected });
    }
    renderFailedBatches();
  }

  function renderFailedBatches() {
    if (!elements.failedBatches || !elements.failedDownloads) return;
    const groups = [...failedBatches.values()].map((batch) => {
      const group = document.createElement('section');
      group.className = 'failed-batch';
      const heading = document.createElement('h3');
      heading.textContent = `${batch.title || '未命名下载任务'} · ${batch.items.length} 项未成功`;
      const context = document.createElement('p');
      context.className = 'failed-batch-context';
      const quality = batch.formatId === 'best' ? '最佳可用画质'
        : typeof batch.formatId === 'string' && batch.formatId.startsWith('h:') ? `${batch.formatId.slice(2)}p 及以下` : batch.formatId || '';
      context.textContent = [quality, batch.directory].filter(Boolean).join(' · ');
      const allLabel = document.createElement('label');
      allLabel.className = 'failed-select-all';
      const all = document.createElement('input');
      all.type = 'checkbox';
      const allText = document.createElement('span');
      allText.textContent = '全选可重试项';
      all.addEventListener('change', () => {
        batch.selected.clear();
        if (all.checked) batch.items.filter((item) => !item.pending).forEach((item) => batch.selected.add(item.itemIndex));
        for (const { checkbox, item } of batch.controls.rows) checkbox.checked = batch.selected.has(item.itemIndex);
        updateFailedControls();
      });
      allLabel.append(all, allText);
      const list = document.createElement('div');
      list.className = 'failed-items';
      list.setAttribute('role', 'list');
      const rows = batch.items.map((item) => {
        const row = document.createElement('label');
        row.className = 'failed-item';
        row.setAttribute('role', 'listitem');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = batch.selected.has(item.itemIndex);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) batch.selected.add(item.itemIndex);
          else batch.selected.delete(item.itemIndex);
          updateFailedControls();
        });
        const copy = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = `第 ${item.itemIndex} 条 · ${item.title || '未命名视频'}`;
        const error = document.createElement('span');
        error.className = 'failed-item-error';
        error.textContent = item.pending ? '已加入重新下载队列…' : item.error || '下载失败';
        copy.append(title, error);
        row.append(checkbox, copy);
        list.append(row);
        return { checkbox, item };
      });
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'button button-outline button-block';
      retry.addEventListener('click', () => retryFailedBatch(batch));
      batch.controls = { all, retry, rows };
      group.append(heading, context, allLabel, list, retry);
      return group;
    });
    elements.failedBatches.replaceChildren(...groups);
    elements.failedDownloads.hidden = groups.length === 0;
    updateFailedControls();
  }

  async function retryFailedBatch(batch) {
    if (!api || typeof api.retryDownload !== 'function' || submittingDownload) return;
    const itemIndices = batch.items.filter((item) => !item.pending && batch.selected.has(item.itemIndex)).map((item) => item.itemIndex);
    if (itemIndices.length === 0) return;
    await submitDownload({ taskId: batch.taskId, itemIndices },
      { kind: batch.kind, title: batch.title, entryCount: itemIndices.length }, true);
  }

  function setSession(result) {
    if (result && result.loginState === 'error') {
      elements.sessionPill.dataset.state = 'unverified';
      elements.sessionLabel.textContent = '暂无法读取会话';
      elements.sessionSummary.textContent = '状态暂不可用';
      elements.sessionSummary.dataset.state = 'unverified';
      elements.loginHelp.textContent = '暂无法检查网站登录状态。解析和下载仍会尝试使用已保存的会话。';
      updateControls();
      return;
    }
    const saved = Number.isFinite(Number(result && result.cookieCount))
      && Number(result.cookieCount) > 0;
    const verified = saved && result.loginState === 'verified';
    const recent = saved && result.loginState === 'recently_verified';
    const signedOut = saved && result.loginState === 'signed_out';
    const state = verified ? 'verified' : recent ? 'recently-verified' : saved ? 'unverified' : 'empty';
    elements.sessionPill.dataset.state = state;
    elements.sessionLabel.textContent = verified ? '网站已确认登录'
      : recent ? '最近确认登录' : signedOut ? '网站显示未登录'
        : saved ? '内嵌会话已保存' : '内嵌会话未保存';
    elements.sessionSummary.textContent = verified ? '已登录'
      : recent ? '最近确认登录' : signedOut ? '未登录 · 网站数据已保存'
        : saved ? '会话已保存 · 登录状态待确认' : '尚未保存';
    elements.sessionSummary.dataset.state = state;
    elements.loginHelp.textContent = verified ? '网站已确认当前登录。解析和下载会使用已保存的会话。'
      : recent ? '最近已在网站确认登录。解析和下载会使用已保存的会话。'
        : signedOut ? '网站显示未登录。请在网页登录窗口重新登录。'
          : saved ? '在网页登录窗口完成登录后，应用会自动确认并关闭该窗口。解析和下载会使用已保存的会话。'
            : '在内嵌窗口登录 Pornhub。解析和下载会自动使用该窗口保存的网站会话。';
    elements.logoutButton.hidden = !saved;
    updateControls();
  }

  function applySessionStatus(result) {
    const revision = result && result.revision;
    if (Number.isInteger(revision) && revision >= 0) {
      if (revision < latestAuthRevision) return false;
      latestAuthRevision = revision;
    }
    setSession(result);
    return true;
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '';
    const minutes = Math.floor(value / 60);
    const remaining = Math.floor(value % 60);
    const hours = Math.floor(minutes / 60);
    if (hours) return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
    return `${minutes}:${String(remaining).padStart(2, '0')}`;
  }

  function safeThumbnailUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:') return '';
      if (host !== 'pornhub.com' && !host.endsWith('.pornhub.com') && host !== 'phncdn.com' && !host.endsWith('.phncdn.com')) return '';
      return url.href;
    } catch {
      return '';
    }
  }

  function clearResource() {
    parsedResource = null;
    setVideoConcurrency();
    elements.mainColumn.classList.remove('has-resource');
    elements.videoEmpty.hidden = false;
    elements.videoDetails.hidden = true;
    elements.formatRow.hidden = true;
    elements.concurrencyCard.hidden = true;
    elements.parsedTitle.textContent = '';
    elements.videoMeta.textContent = '';
    elements.resourceKind.textContent = '已解析的内容';
    elements.thumbnailPlaceholder.textContent = '▶';
    elements.thumbnail.removeAttribute('src');
    elements.thumbnail.hidden = true;
    elements.thumbnailPlaceholder.hidden = false;
    elements.formatSelect.replaceChildren();
    updateControls();
  }

  function showResource(resource) {
    parsedResource = resource;
    elements.mainColumn.classList.add('has-resource');
    const kind = kindNames[resource.kind] || kindNames.video;
    const isBatch = resource.kind === 'playlist' || resource.kind === 'pornstar';
    setVideoConcurrency();
    elements.resourceKind.textContent = `已解析的${kind}`;
    elements.thumbnailPlaceholder.textContent = isBatch ? '▤' : '▶';
    elements.parsedTitle.textContent = typeof resource.title === 'string' && resource.title.trim() ? resource.title : `未命名${kind}`;
    const count = Number(resource.entryCount);
    const details = [kind, isBatch && Number.isInteger(count) ? `${count} 条视频` : '',
      resource.id ? `ID ${String(resource.id)}` : '', !isBatch ? formatDuration(resource.duration) : ''].filter(Boolean);
    elements.videoMeta.textContent = details.join(' · ');

    const thumbnail = safeThumbnailUrl(resource.thumbnail);
    elements.thumbnail.hidden = !thumbnail;
    elements.thumbnailPlaceholder.hidden = Boolean(thumbnail);
    if (thumbnail) elements.thumbnail.src = thumbnail;
    else elements.thumbnail.removeAttribute('src');

    const choices = Array.isArray(resource.formats) ? resource.formats : [];
    for (const format of choices) {
      if (!format || format.id == null) continue;
      const option = document.createElement('option');
      option.value = String(format.id);
      option.textContent = typeof format.label === 'string' && format.label.trim()
        ? format.label
        : [format.height ? `${format.height}p` : '', format.ext || ''].filter(Boolean).join(' · ') || String(format.id);
      elements.formatSelect.append(option);
    }
    elements.videoEmpty.hidden = true;
    elements.videoDetails.hidden = false;
    elements.formatRow.hidden = false;
    elements.concurrencyCard.hidden = false;
    updateControls();
  }

  function setProgress(percent, status, detail) {
    const numeric = Number(percent);
    const bounded = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
    elements.progressEmpty.hidden = true;
    elements.progressContent.hidden = false;
    elements.progressStatus.textContent = status;
    elements.progressPercent.textContent = `${Math.round(bounded)}%`;
    elements.progressFill.style.width = `${bounded}%`;
    elements.progressTrack.setAttribute('aria-valuenow', String(Math.round(bounded)));
    elements.progressDetail.textContent = detail;
  }

  function setProgressItem(event) {
    const resource = activeDownloadResource;
    if (!resource || resource.kind === 'video') {
      elements.progressItem.hidden = true;
      elements.progressItem.textContent = '';
      return;
    }
    const activeVideos = Array.isArray(event && event.activeVideos)
      ? event.activeVideos.filter((video) => Number.isInteger(video.itemIndex) && video.itemIndex > 0)
      : [];
    if (activeVideos.length > 1) {
      // Concurrent workers report progress independently. Keep the headline steady
      // instead of replacing it with whichever video's event arrived last; the
      // ordered rows below carry each video's live title, speed, and ETA.
      elements.progressItem.textContent = `当前并发下载：${activeVideos.length} 条视频`;
      elements.progressItem.hidden = false;
      return;
    }
    const index = Number(event && event.itemIndex);
    const eventCount = Number(event && event.itemCount);
    const parsedCount = Number(resource.entryCount);
    const count = Number.isInteger(eventCount) && eventCount > 0 ? eventCount : parsedCount;
    const activeVideo = activeVideos[0];
    const activeIndex = Number.isInteger(index) && index > 0 ? index : activeVideo && activeVideo.itemIndex;
    const position = Number.isInteger(activeIndex) && Number.isInteger(count) && count > 0
      ? `第 ${activeIndex} / ${count} 条` : Number.isInteger(count) && count > 0 ? `共 ${count} 条` : '批量下载';
    const eventTitle = typeof (event && event.currentTitle) === 'string' ? event.currentTitle.trim() : '';
    const title = activeVideos.length === 1 && !eventTitle && typeof activeVideo.title === 'string'
      ? activeVideo.title.trim() : eventTitle;
    const attempt = Number(event && event.attempt);
    const maxAttempts = Number(event && event.maxAttempts);
    const retry = Number.isInteger(attempt) && attempt > 1 && Number.isInteger(maxAttempts)
      ? ` · 第 ${attempt}/${maxAttempts} 次尝试` : '';
    elements.progressItem.textContent = title ? `${position} · ${title}${retry}` : `${position}${retry}`;
    elements.progressItem.hidden = false;
  }

  function batchCounts(event) {
    const completed = Number(event && event.completedCount);
    const failed = Number(event && event.failedCount);
    if (!Number.isInteger(completed) || completed < 0 || !Number.isInteger(failed) || failed < 0) return '';
    return `成功 ${completed} 条，失败 ${failed} 条`;
  }

  function finishProgressItem(event, counts) {
    const resource = activeDownloadResource;
    if (!resource || resource.kind === 'video') return;
    const count = Number(resource.entryCount);
    const parts = [Number.isInteger(count) && count > 0 ? `共 ${count} 条` : '', counts].filter(Boolean);
    elements.progressItem.textContent = parts.join(' · ') || '批量任务已结束';
    elements.progressItem.hidden = false;
  }

  function applyLoginWindowState(state) {
    if (!state || typeof state.windowOpen !== 'boolean' || !Number.isInteger(state.revision)
        || state.revision < loginWindowRevision) return false;
    loginWindowRevision = state.revision;
    loginWindowOpen = state.windowOpen;
    updateControls();
    return true;
  }

  async function openLogin() {
    if (!api || loginBusy) return;
    loginBusy = true;
    updateControls();
    try {
      const result = await api.openLogin();
      if (applyLoginWindowState(result) && loginWindowOpen) {
        showNotice('登录窗口已打开。完成登录后会自动确认并关闭；若被遮住，可点击“显示登录窗口”。');
      }
    } catch (error) {
      showNotice(`打开登录窗口失败：${errorMessage(error)}`, 'error');
    } finally {
      loginBusy = false;
      updateControls();
    }
  }

  function onLoginClosed(result) {
    if (!applySessionStatus(result)) return;
    sessionRevision++;
    if (!hasDownloadWork()) {
      parseGeneration++;
      parsing = false;
      clearResource();
    }
    if (result && result.loginState === 'recently_verified') {
      showNotice('网页登录窗口已关闭，最近确认过登录。解析和下载将使用已保存的会话。', 'success');
    } else if (result && result.loginState === 'signed_out') {
      showNotice('网页登录窗口已关闭，网站显示未登录。需要账号的视频请重新登录。');
    } else if (result && result.loginState === 'error') {
      showNotice('网页登录窗口已关闭，暂无法确认网站数据。解析和下载仍会尝试使用当前会话。');
    } else if (Number(result && result.cookieCount) > 0) {
      showNotice('网页登录窗口已关闭，网站数据已保存。解析和下载将使用当前会话。');
    } else {
      showNotice('内嵌网页登录窗口已关闭，尚无网站数据。');
    }
    updateControls();
  }

  async function logout() {
    if (!api || loginBusy) return;
    loginBusy = true;
    updateControls();
    try {
      const result = await api.logout();
      sessionRevision++;
      if (!applySessionStatus(result)) return;
      parseGeneration++;
      parsing = false;
      clearResource();
      showNotice('内嵌窗口会话已清除。', 'success');
    } catch (error) {
      showNotice(`清除会话失败：${errorMessage(error)}`, 'error');
    } finally {
      loginBusy = false;
      updateControls();
    }
  }

  function setCredentialsStatus(result) {
    credentialsReady = true;
    credentialsAvailable = Boolean(result && result.available);
    credentialsSaved = Boolean(result && result.saved);
    credentialsUnreadable = Boolean(result && result.error);
    updateControls();
  }

  async function changeCredentials(action) {
    if (!api || credentialsBusy || loginBusy || hasDownloadWork() || !credentialsReady) return;
    if (action !== 'delete' && (!credentialsAvailable || !loginWindowOpen)) return;
    if (action !== 'save' && !credentialsSaved) return;
    if (action === 'fill' && credentialsUnreadable) return;
    const method = action === 'save' ? 'saveCredentials'
      : action === 'fill' ? 'fillCredentials' : 'deleteCredentials';
    if (typeof api[method] !== 'function') return;
    credentialsBusy = true;
    updateControls();
    try {
      const result = await api[method]();
      if (action === 'fill' && (!result || result.filled !== true)) {
        throw new Error('网页登录状态已变化，请等待登录页加载后重试。');
      }
      showNotice(action === 'save' ? '账号密码已加密保存到本机。请返回网页登录窗口确认并提交登录。'
        : action === 'fill' ? '已填入账号密码，请在网页登录窗口确认并提交登录。'
          : '保存的账号密码已删除。当前网站会话仍会保留。', 'success');
    } catch (error) {
      const label = action === 'save' ? '保存账号密码' : action === 'fill' ? '填充账号密码' : '删除账号密码';
      showNotice(`${label}失败：${errorMessage(error)}`, 'error');
    } finally {
      credentialsBusy = false;
      updateControls();
    }
  }

  async function parseResource(event) {
    event.preventDefault();
    if (!api || parsing || composingUrl) return;
    const url = elements.urlInput.value.trim();
    if (!url) {
      elements.urlInput.setAttribute('aria-invalid', 'true');
      elements.urlHelp.textContent = '请粘贴 Pornhub 页面网址。';
      showNotice('请粘贴 Pornhub 页面网址。', 'error');
      elements.urlInput.focus();
      return;
    }
    elements.urlInput.removeAttribute('aria-invalid');
    elements.urlHelp.textContent = urlHelpText;
    const generation = ++parseGeneration;
    clearResource();
    hideNotice();
    parsing = true;
    updateControls();
    try {
      const resource = await api.parse(url);
      if (generation !== parseGeneration || elements.urlInput.value.trim() !== url) return;
      if (!resource || !Array.isArray(resource.formats) || resource.formats.length === 0) {
        throw new Error('没有找到可下载的画质。');
      }
      if ((resource.kind === 'playlist' || resource.kind === 'pornstar') && Number(resource.entryCount) <= 0) {
        throw new Error('没有找到可下载的视频。');
      }
      if (typeof resource.snapshotId !== 'string' || !resource.snapshotId) throw new Error('无法识别解析结果，请重新解析。');
      showResource(resource);
    } catch (error) {
      if (generation === parseGeneration) showNotice(`解析失败：${errorMessage(error)}`, 'error');
    } finally {
      if (generation === parseGeneration) {
        parsing = false;
        updateControls();
      }
    }
  }

  async function selectDirectory() {
    if (!api || directoryLoading || selectingDirectory) return;
    selectingDirectory = true;
    updateControls();
    try {
      const selected = await api.selectDirectory();
      if (typeof selected === 'string' && selected.trim()) {
        directory = selected;
        elements.directoryLabel.textContent = selected;
        elements.directoryPath.classList.add('has-value');
      }
    } catch (error) {
      showNotice(`选择文件夹失败：${errorMessage(error)}`, 'error');
    } finally {
      selectingDirectory = false;
      updateControls();
    }
  }

  function activateDownload(task) {
    activeTaskId = task.taskId;
    activeDownloadResource = task.resource;
    cancelling = false;
    setProgress(0, '正在下载', '正在连接媒体服务器…');
    setProgressItem();
    renderActiveVideos([]);
    updateControls();
  }

  function hasDownloadWork() {
    return Boolean(activeTaskId || queuedTasks.length || submittingDownload);
  }

  async function startDownload() {
    if (!api || !concurrencyOptions || !parsedResource || !directory || !elements.formatSelect.value
        || parsing || submittingDownload) return;
    const resource = parsedResource;
    const request = {
      snapshotId: resource.snapshotId,
      formatId: elements.formatSelect.value,
      fragmentConcurrency: Number(elements.fragmentConcurrency.value),
      videoConcurrency: resource.kind === 'video' ? concurrencyOptions.video[0] : Number(batchVideoConcurrency),
      directory,
    };
    await submitDownload(request, resource);
  }

  async function submitDownload(request, resource, retry = false) {
    const wasIdle = !hasDownloadWork();
    submittingDownload = true;
    hideNotice();
    if (wasIdle) {
      setProgress(0, '准备下载', '正在创建下载任务…');
      setProgressItem();
    }
    updateControls();
    try {
      const task = await (retry ? api.retryDownload(request) : api.download(request));
      if (!task || typeof task.taskId !== 'string' || !task.taskId) throw new Error('下载任务未能启动。');
      applyFailedBatch(task.failedBatch);
      queuedTasks.push({ taskId: task.taskId, resource });
      const earlyEvents = pendingDownloadEvents.filter((event) => event.taskId === task.taskId);
      if (task.queued && earlyEvents.length === 0) {
        showNotice('已加入下载队列，前方还有 ' + Math.max(0, Number(task.queuePosition) - 1) + ' 个任务。', 'success');
      }
      for (const event of earlyEvents) onDownloadEvent(event);
    } catch (error) {
      if (wasIdle && !activeTaskId && queuedTasks.length === 0) {
        setProgress(0, '启动失败', errorMessage(error));
      }
      showNotice('下载失败：' + errorMessage(error), 'error');
    } finally {
      submittingDownload = false;
      pendingDownloadEvents = [];
      updateControls();
    }
  }

  async function cancelDownload() {
    const taskId = activeTaskId;
    if (!api || !taskId || cancelling) return;
    const previousStatus = elements.progressStatus.textContent;
    const previousDetail = elements.progressDetail.textContent;
    cancelling = true;
    elements.progressStatus.textContent = '正在取消';
    elements.progressDetail.textContent = '正在停止下载任务…';
    updateControls();
    try {
      if (await api.cancel(taskId) !== false) return;
      throw new Error('该任务已结束。');
    } catch (error) {
      if (activeTaskId !== taskId) return;
      cancelling = false;
      elements.progressStatus.textContent = previousStatus;
      elements.progressDetail.textContent = previousDetail;
      showNotice(`取消下载失败：${errorMessage(error)}`, 'error');
      updateControls();
    }
  }

  function renderActiveVideos(videos) {
    if (!Array.isArray(videos) || videos.length === 0) {
      elements.progressVideos.replaceChildren();
      elements.progressVideos.hidden = true;
      return;
    }
    const rows = videos.filter((video) => Number.isInteger(video.itemIndex) && video.itemIndex > 0)
      .map((video) => {
        const row = document.createElement('div');
        row.className = 'download-list-row progress-video';
        row.setAttribute('role', 'listitem');
        const title = document.createElement('span');
        title.className = 'progress-video-title text-ellipsis';
        title.textContent = `第 ${video.itemIndex} 条 · ${typeof video.title === 'string' && video.title.trim() ? video.title : '未命名视频'}`;
        const speed = document.createElement('span');
        speed.className = 'progress-video-speed';
        speed.textContent = typeof video.speed === 'string' && video.speed ? video.speed : '测速中…';
        row.append(title, speed);
        if (typeof video.eta === 'string' && video.eta) {
          const eta = document.createElement('span');
          eta.className = 'progress-video-eta';
          eta.textContent = `剩余 ${video.eta}`;
          row.append(eta);
        }
        return row;
      });
    elements.progressVideos.replaceChildren(...rows);
    elements.progressVideos.hidden = rows.length === 0;
  }

  function onDownloadEvent(event) {
    if (!event || typeof event.taskId !== 'string') return;
    if (event.taskId !== activeTaskId) {
      const queuedIndex = queuedTasks.findIndex((task) => task.taskId === event.taskId);
      if (queuedIndex >= 0) {
        if (event.type === 'started' && !activeTaskId) {
          const [task] = queuedTasks.splice(queuedIndex, 1);
          activateDownload(task);
          return;
        } else if (['completed', 'partial', 'failed', 'cancelled'].includes(event.type)) {
          queuedTasks.splice(queuedIndex, 1);
          applyFailedBatch(event.failedBatch);
          updateControls();
          return;
        } else {
          return;
        }
      } else if (submittingDownload) {
        if (event.type === 'progress') {
          pendingDownloadEvents = pendingDownloadEvents.filter((pending) =>
            pending.taskId !== event.taskId || pending.type !== 'progress');
        }
        pendingDownloadEvents.push(event);
        return;
      } else {
        return;
      }
    }
    if (event.type === 'started' || (cancelling && ['progress', 'retry'].includes(event.type))) return;
    if (Array.isArray(event.activeVideos)) renderActiveVideos(event.activeVideos);
    const speed = typeof event.speed === 'string' ? event.speed : '';
    const eta = typeof event.eta === 'string' ? event.eta : '';
    const attempt = Number(event.attempt);
    const maxAttempts = Number(event.maxAttempts);
    const attemptDetail = Number.isInteger(attempt) && attempt > 1 && Number.isInteger(maxAttempts)
      ? `第 ${attempt}/${maxAttempts} 次尝试` : '';
    const activeCount = Array.isArray(event.activeVideos) ? event.activeVideos.length : Number(event.activeCount);
    const retryCount = Number(event.retryCount);
    const hasActivitySummary = Array.isArray(event.activeVideos) || Number.isInteger(activeCount);
    const countShownInItem = Array.isArray(event.activeVideos) && activeCount > 1;
    const activeDetail = !countShownInItem && Number.isInteger(activeCount) && activeCount > 0
      ? `同时下载 ${activeCount} 条` : '';
    const retryDetail = Number.isInteger(retryCount) && retryCount > 0 ? `${retryCount} 条等待重试` : '';
    const detail = hasActivitySummary
      ? [activeDetail, retryDetail].filter(Boolean).join(' · ')
      : [attemptDetail, speed ? `当前视频 ${speed}` : '', eta ? `当前视频剩余 ${eta}` : ''].filter(Boolean).join(' · ');
    if (event.type === 'progress') {
      const waitingForRetry = hasActivitySummary && activeCount === 0 && retryCount > 0;
      const progressDetail = detail || (countShownInItem ? '' : event.message || '正在下载…');
      setProgress(event.percent, waitingForRetry ? '等待重试' : '正在下载', progressDetail);
      setProgressItem(event);
      return;
    }
    if (event.type === 'retry') {
      const status = hasActivitySummary && activeCount > 0 ? '正在下载' : '等待重试';
      const retryDetailText = hasActivitySummary
        ? [detail, activeCount > 0 ? '失败项已加入重试队列' : '等待重试任务启动'].filter(Boolean).join(' · ')
        : event.message || '已加入队列末尾。';
      setProgress(event.percent, status, retryDetailText);
      setProgressItem(event);
      return;
    }

    const batch = activeDownloadResource?.kind !== 'video';
    const counts = batch ? batchCounts(event) : '';
    if (event.type === 'completed') {
      const count = batch ? Number(event.completedCount ?? activeDownloadResource?.entryCount) : 0;
      const summary = count > 0 ? `${count} 条视频已保存到所选文件夹。` : '文件已保存到所选文件夹。';
      setProgress(100, '下载完成', event.message || summary);
      showNotice(count > 0 ? `${count} 条视频下载完成。` : '下载完成。', 'success');
    } else if (event.type === 'partial') {
      const message = event.message || '部分视频未能下载。';
      setProgress(event.percent ?? 100, '部分完成', message);
      showNotice(`批量下载部分完成：${[counts, message].filter(Boolean).join(' · ')}`, 'error');
    } else if (event.type === 'failed') {
      const message = event.message || '下载过程中发生错误。';
      setProgress(event.percent, '下载失败', message);
      showNotice(`下载失败：${[counts, message].filter(Boolean).join(' · ')}`, 'error');
    } else if (event.type === 'cancelled') {
      setProgress(event.percent, '已取消', event.message || '下载任务已取消。');
    } else {
      return;
    }
    applyFailedBatch(event.failedBatch);
    finishProgressItem(event, counts);
    renderActiveVideos([]);
    activeTaskId = null;
    activeDownloadResource = null;
    cancelling = false;
    updateControls();
  }

  function bindConfirmation(trigger, dialog, cancelButton, confirmAction) {
    trigger.addEventListener('click', () => {
      if (trigger.disabled) return;
      dialog.returnValue = '';
      dialog.showModal();
      cancelButton.focus();
    });
    dialog.addEventListener('close', () => {
      if (dialog.returnValue === 'confirm') {
        dialog.returnValue = '';
        confirmAction();
      }
    });
  }

  elements.noticeClose.addEventListener('click', hideNotice);
  elements.loginButton.addEventListener('click', openLogin);
  elements.credentialsSave.addEventListener('click', () => changeCredentials('save'));
  elements.credentialsFill.addEventListener('click', () => changeCredentials('fill'));
  bindConfirmation(elements.credentialsDelete, elements.deleteCredentialsDialog,
    elements.deleteCredentialsCancel, () => changeCredentials('delete'));
  bindConfirmation(elements.logoutButton, elements.clearSessionDialog, elements.clearSessionCancel, logout);
  elements.parseForm.addEventListener('submit', parseResource);
  elements.urlInput.addEventListener('input', () => {
    elements.urlInput.removeAttribute('aria-invalid');
    elements.urlHelp.textContent = urlHelpText;
    parseGeneration++;
    parsing = false;
    clearResource();
  });
  elements.urlInput.addEventListener('compositionstart', () => { composingUrl = true; });
  elements.urlInput.addEventListener('compositionend', () => { composingUrl = false; });
  elements.urlClear.addEventListener('click', () => {
    elements.urlInput.value = '';
    elements.urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    elements.urlInput.focus();
  });
  elements.formatSelect.addEventListener('change', updateControls);
  elements.fragmentConcurrency.addEventListener('change', saveConcurrencySettings);
  elements.videoConcurrency.addEventListener('change', saveConcurrencySettings);
  elements.directoryButton.addEventListener('click', selectDirectory);
  elements.downloadButton.addEventListener('click', startDownload);
  elements.cancelButton.addEventListener('click', cancelDownload);
  elements.queueToggle.addEventListener('click', () => {
    queueExpanded = !queueExpanded;
    renderQueue();
  });
  elements.thumbnail.addEventListener('error', () => {
    elements.thumbnail.hidden = true;
    elements.thumbnailPlaceholder.hidden = false;
  });

  updateControls();
  if (!api || typeof api.sessionStatus !== 'function' || typeof api.onDownloadEvent !== 'function'
      || typeof api.onLoginClosed !== 'function' || typeof api.getDirectory !== 'function') {
    elements.sessionLabel.textContent = '服务不可用';
    elements.sessionSummary.textContent = '服务不可用';
    showNotice('无法连接到桌面服务，请重新启动应用。', 'error');
    elements.loginButton.disabled = true;
    elements.parseButton.disabled = true;
    elements.directoryButton.disabled = true;
    return;
  }

  api.onDownloadEvent(onDownloadEvent);
  api.onLoginClosed(onLoginClosed);
  api.onLoginWindowChanged?.(applyLoginWindowState);
  api.concurrencyOptions?.().then(configureConcurrency).catch((error) => {
    showNotice(`读取下载并发设置失败：${errorMessage(error)}`, 'error');
  });
  if (typeof api.onSessionStatusChanged === 'function') {
    api.onSessionStatusChanged((result) => {
      if (!applySessionStatus(result)) return;
      sessionRevision++;
    });
  }
  if (typeof api.credentialsStatus === 'function') {
    if (typeof api.onCredentialsChanged === 'function') {
      api.onCredentialsChanged((result) => {
        credentialsRevision++;
        setCredentialsStatus(result);
      });
    }
    const initialCredentialsRevision = credentialsRevision;
    api.credentialsStatus().then((result) => {
      if (credentialsRevision === initialCredentialsRevision) setCredentialsStatus(result);
    }).catch((error) => {
      if (credentialsRevision !== initialCredentialsRevision) return;
      showNotice(`读取保存的账号密码失败：${errorMessage(error)}`, 'error');
    });
  }
  elements.directoryLabel.textContent = '正在读取保存目录…';
  api.getDirectory().then((selected) => {
    if (typeof selected !== 'string' || !selected.trim()) throw new Error('没有可用的默认保存目录。');
    directory = selected;
    elements.directoryLabel.textContent = selected;
    elements.directoryPath.classList.add('has-value');
  }).catch((error) => {
    elements.directoryLabel.textContent = '请选择保存目录';
    showNotice(`读取保存目录失败：${errorMessage(error)}`, 'error');
  }).finally(() => {
    directoryLoading = false;
    updateControls();
  });
  const initialSessionRevision = sessionRevision;
  api.sessionStatus().then((result) => {
    if (sessionRevision === initialSessionRevision) applySessionStatus(result);
  }).catch((error) => {
    if (sessionRevision !== initialSessionRevision) return;
    elements.sessionLabel.textContent = '无法读取会话';
    elements.sessionSummary.textContent = '无法读取';
    showNotice(`读取会话失败：${errorMessage(error)}`, 'error');
  });
})();
