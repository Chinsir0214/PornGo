(() => {
  'use strict';

  const api = window.porngo;
  const { formatDuration, safeThumbnailUrl, formatQuality, batchCounts, errorMessage,
    kindNames, downloadStates, terminalDownloadStates, createRevisionGuard,
    setText, createIcon, bindConfirmation } = window.PornGoRenderer;
  const disposers = [];
  window.addEventListener('pagehide', () => {
    for (const dispose of disposers.splice(0)) if (typeof dispose === 'function') dispose();
  }, { once: true });
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
    credentialsRefresh: document.getElementById('credentials-refresh'),
    credentialsSave: document.getElementById('credentials-save'),
    credentialsFill: document.getElementById('credentials-fill'),
    credentialsDelete: document.getElementById('credentials-delete'),
    deleteCredentialsDialog: document.getElementById('delete-credentials-dialog'),
    deleteCredentialsConfirm: document.getElementById('delete-credentials-confirm'),
    clearSessionConfirm: document.getElementById('clear-session-confirm'),
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
    videoPreview: document.getElementById('video-preview'),
    videoDetails: document.getElementById('video-details'),
    performerDetails: document.getElementById('performer-details'),
    performerHeading: document.getElementById('performer-heading'),
    performerCount: document.getElementById('performer-selection-count'),
    performerAll: document.getElementById('performer-select-all'),
    performerEntries: document.getElementById('performer-entries'),
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
    queueAnnouncement: document.getElementById('queue-announcement'),
    queueToggle: document.getElementById('queue-toggle'),
    queueList: document.getElementById('queue-list'),
    downloadTaskHistory: document.getElementById('download-task-history'),
    downloadTaskList: document.getElementById('download-task-list'),
    progressCard: document.querySelector('.progress-card'),
    cancelButton: document.getElementById('cancel-button'),
    failedDownloads: document.getElementById('failed-downloads'),
    failedBatches: document.getElementById('failed-batches'),
    clearSessionDialog: document.getElementById('clear-session-dialog'),
    clearSessionCancel: document.getElementById('clear-session-cancel')
  };

  let parsedResource = null;
  let performerChecks = [];
  let selectedItemIndices = [];
  let concurrencyOptions = null;
  let batchVideoConcurrency = '';
  let directory = '';
  let directoryLoading = true;
  let selectingDirectory = false;
  let activeTaskId = null;
  let activeDownloadResource = null;
  const queuedTasks = [];
  const downloadTasks = new Map();
  const queueRows = new Map();
  const cancellingQueuedTasks = new Set();
  let queueExpanded = false;
  const MAX_FAILED_BATCHES = 20;
  const failedBatches = new Map();
  const failedBatchRevisions = new Map();
  let submittingDownload = false;
  let parsing = false;
  let cancelling = false;
  let loginBusy = false;
  let loginWindowOpen = false;
  const acceptLoginWindowRevision = createRevisionGuard();
  let credentialsReady = false;
  let credentialsAvailable = false;
  let credentialsSaved = false;
  let credentialsUnreadable = false;
  let credentialsBusy = false;
  let credentialsRevision = 0;
  let parseGeneration = 0;
  let composingUrl = false;
  let pendingDownloadEvents = [];
  let pendingProgress = null;
  let progressFrame = null;
  const changedProgressItems = new Set();
  let activeVideoRows = new Map();
  let sessionRevision = 0;
  const acceptAuthRevision = createRevisionGuard();
  let authState = '';
  let parseAuthState = '';
  const finishedTaskIds = [];
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
      const optionsFragment = document.createDocumentFragment();
      for (const value of values) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `${value === 1 ? '顺序' : '并发'} · ${value} ${unit}`;
        optionsFragment.append(option);
      }
      select.replaceChildren(optionsFragment);
    }
    concurrencyOptions = options;
    const fragment = options.fragment.map(String);
    const video = options.video.map(String);
    elements.fragmentConcurrency.value = fragment.includes(saved?.fragmentConcurrency)
      ? saved.fragmentConcurrency : String(options.defaults?.fragment ?? fragment[0]);
    batchVideoConcurrency = video.includes(saved?.videoConcurrency)
      ? saved.videoConcurrency : String(options.defaults?.video ?? video[0]);
    setVideoConcurrency();
    updateDownloadControls();
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
    const toggleFocused = document.activeElement === elements.queueToggle;
    elements.queueToggle.hidden = count === 0;
    if (count === 0 && toggleFocused) elements.progressStatus.focus({ preventScroll: true });
    setText(elements.queueStatus, status);
    setText(elements.queueAnnouncement, status);
    elements.queueToggle.setAttribute('aria-expanded', String(queueExpanded));
    elements.queueList.hidden = count === 0 || !queueExpanded;
    queuedTasks.forEach((task, index) => {
      let controls = queueRows.get(task.taskId);
      if (!controls) {
        const row = document.createElement('div');
        row.className = 'download-list-row queue-row';
        row.dataset.testid = 'queue-item';
        row.setAttribute('role', 'listitem');
        const title = document.createElement('span');
        title.className = 'queue-row-title';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'button button-outline queue-row-remove';
        remove.addEventListener('click', () => removeQueuedTask(task.taskId));
        row.append(title, remove);
        if (task.items.size) {
          task.view = createTaskDetails(task, true);
          row.append(task.view.details);
        }
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

  function createTaskDetails(task, queued = false) {
    const details = document.createElement('details');
    details.className = 'download-task-details';
    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.className = 'download-task-title';
    const status = document.createElement('span');
    status.className = 'download-task-status';
    const disclosure = createIcon('chevron-down', 'download-task-summary-icon');
    summary.append(title, status, disclosure);
    const error = document.createElement('p');
    error.className = 'download-task-error';
    error.hidden = true;
    const items = document.createElement('ul');
    items.className = 'download-task-items';
    details.append(summary, error, items);
    const view = { details, summary, title, status, error, items, rows: new Map() };
    if (queued) {
      title.textContent = `视频明细 · ${task.items.size} 条`;
      status.hidden = true;
    }
    details.addEventListener('toggle', () => {
      if (!details.open || view.rows.size) return;
      for (const item of task.items.values()) renderTaskItem(view, item);
    });
    return view;
  }

  function renderTaskItem(view, item) {
    if (!view) return;
    let controls = view.rows.get(item.itemIndex);
    if (!controls) {
      if (!view.details.open) return;
      const row = document.createElement('li');
      const title = document.createElement('strong');
      const status = document.createElement('span');
      status.className = 'download-task-status';
      const progress = document.createElement('progress');
      progress.max = 100;
      const error = document.createElement('span');
      error.className = 'download-task-error';
      const file = document.createElement('span');
      file.className = 'download-task-file';
      row.append(title, status, progress, error, file);
      view.items.append(row);
      controls = { title, status, progress, error, file };
      view.rows.set(item.itemIndex, controls);
    }
    setText(controls.title, `${item.itemIndex}. ${item.title || '未命名视频'}`);
    controls.status.dataset.state = item.state;
    const percent = Number.isFinite(item.percent) ? Math.round(item.percent) : null;
    setText(controls.status, [downloadStates[item.state], percent === null ? '' : `${percent}%`,
      item.attempt > 1 ? `第 ${item.attempt}/${item.maxAttempts} 次尝试` : '',
      item.speed, item.eta ? `剩余 ${item.eta}` : ''].filter(Boolean).join(' · '));
    controls.progress.hidden = percent === null || item.state !== 'downloading';
    if (!controls.progress.hidden) {
      controls.progress.value = percent;
      controls.progress.setAttribute('aria-label', `${item.title || '未命名视频'}的下载进度`);
    }
    setText(controls.error, item.error || '');
    controls.error.hidden = !item.error;
    setText(controls.file, item.fileName || '');
    controls.file.hidden = !item.fileName || item.fileName === item.title;
  }

  function renderTaskSummary(task) {
    const { view } = task;
    const count = task.items.size || task.resource.entryCount;
    const showPercent = Number.isFinite(task.percent)
      && (!terminalDownloadStates.includes(task.state) || task.state === 'completed');
    const videoTitle = task.resource.kind === 'video' ? task.items.get(1)?.title : '';
    setText(view.title, videoTitle || task.resource.title || '未命名下载任务');
    const state = task.taskId === activeTaskId && cancelling && !terminalDownloadStates.includes(task.state) ? 'cancelling' : task.state;
    view.status.dataset.state = state;
    setText(view.status, [task.retry ? '重新下载' : '', downloadStates[state],
      count > 0 ? `${count} 条` : '', showPercent ? `${Math.round(task.percent)}%` : '',
      task.counts].filter(Boolean).join(' · '));
    setText(view.error, task.error || '');
    view.error.hidden = !task.error;
  }

  function addTaskToHistory(task) {
    const row = document.createElement('li');
    const hadFocus = task.view && document.activeElement === task.view.summary;
    task.view ||= createTaskDetails(task);
    task.view.status.hidden = false;
    renderTaskSummary(task);
    row.append(task.view.details);
    elements.downloadTaskList.append(row);
    elements.downloadTaskHistory.hidden = false;
    if (hadFocus) task.view.summary.focus();
  }

  function recordFinishedTask(taskId) {
    finishedTaskIds.push(taskId);
    if (finishedTaskIds.length <= 50) return;
    const oldest = finishedTaskIds.shift();
    downloadTasks.get(oldest)?.view?.details.parentElement?.remove();
    downloadTasks.delete(oldest);
  }

  function updateTaskDetails(task, event, deferProgress = false) {
    const item = event.itemUpdate;
    if (item && task.items.has(item.itemIndex)) {
      const previous = task.items.get(item.itemIndex);
      const next = { ...item, title: item.title || previous.title };
      task.items.set(item.itemIndex, next);
      if (task.view?.rows.has(next.itemIndex)) {
        if (deferProgress) changedProgressItems.add(next.itemIndex);
        else renderTaskItem(task.view, next);
      }
    }
    if (Number.isFinite(event.percent)) task.percent = event.percent;
    if (task.items.size > 1) task.counts = batchCounts(event);
    if (terminalDownloadStates.includes(event.type)) {
      task.state = event.type;
      task.error = ['failed', 'partial', 'cancelled'].includes(event.type) ? event.message : '';
      for (const item of task.items.values()) {
        if (terminalDownloadStates.includes(item.state)) continue;
        item.state = event.type === 'partial' ? 'failed' : event.type;
        item.speed = '';
        item.eta = '';
        if (item.state === 'failed') item.error = event.message;
        if (item.state === 'completed') item.percent = 100;
        if (task.view?.rows.has(item.itemIndex)) renderTaskItem(task.view, item);
      }
    } else if (['progress', 'retry'].includes(event.type)) {
      task.latestActivity = event;
      const active = Array.isArray(event.activeVideos) ? event.activeVideos.length : event.activeCount;
      task.state = (active === 0 && event.retryCount > 0) || (event.type === 'retry' && !active)
        ? 'retry' : 'downloading';
    }
    if (!deferProgress && task.view && task.state !== 'queued') renderTaskSummary(task);
  }

  async function removeQueuedTask(taskId) {
    if (!api || cancellingQueuedTasks.has(taskId)
        || !queuedTasks.some((task) => task.taskId === taskId)) return;
    cancellingQueuedTasks.add(taskId);
    renderQueue();
    try {
      const removed = await api.removeQueued(taskId);
      if (!removed && activeTaskId === taskId) showNotice('该任务已开始下载，无法从等待队列移除。');
    } catch (error) {
      showNotice(`移除排队任务失败：${errorMessage(error)}`, 'error');
    } finally {
      cancellingQueuedTasks.delete(taskId);
      renderQueue();
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
    disposers.push(api.onWindowState(setWindowState));
    elements.windowMinimize.addEventListener('click', () => api.minimizeWindow().catch(() => {}));
    elements.windowMaximize.addEventListener('click', () => api.toggleMaximizeWindow().then(setWindowState).catch(() => {}));
    elements.windowClose.addEventListener('click', () => api.closeWindow().catch(() => {}));
    elements.appHeader.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, .header-actions, .window-controls')) return;
      api.toggleMaximizeWindow().then(setWindowState).catch(() => {});
    });
  }

  function showNotice(message, kind = 'info') {
    elements.noticeMessage.textContent = String(message);
    elements.notice.dataset.kind = kind;
    elements.notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    elements.notice.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    elements.noticeClose.disabled = false;
    elements.noticeClose.hidden = false;
    elements.notice.classList.remove('sr-only');
  }

  function hideNotice() {
    elements.notice.classList.add('sr-only');
    elements.noticeClose.hidden = true;
    elements.noticeMessage.textContent = '';
    elements.noticeClose.disabled = true;
  }

  function updateParseControls() {
    const hasUrl = Boolean(elements.urlInput.value.trim());
    elements.urlInput.disabled = false;
    elements.urlClear.hidden = !hasUrl;
    elements.urlClear.disabled = !hasUrl;
    elements.parseButton.disabled = !hasUrl || parsing;
    elements.parseButton.textContent = parsing ? '解析中…' : '解析链接';
    elements.parseButton.classList.toggle('is-busy', parsing);
    elements.parseButton.setAttribute('aria-busy', String(parsing));
  }

  function updateDownloadControls() {
    const downloadWork = hasDownloadWork();
    elements.directoryButton.disabled = directoryLoading || selectingDirectory;
    elements.formatSelect.disabled = false;
    elements.fragmentConcurrency.disabled = !concurrencyOptions;
    elements.videoConcurrency.disabled = !concurrencyOptions || !parsedResource || parsedResource.kind === 'video';
    elements.downloadButton.disabled = !concurrencyOptions || !parsedResource || !directory
      || (parsedResource.kind === 'pornstar' && !selectedItemIndices.length)
      || !elements.formatSelect.value || parsing || submittingDownload;
    elements.downloadLabel.textContent = submittingDownload ? '正在加入…'
      : downloadWork ? '加入下载队列' : '开始下载';
    elements.downloadButton.classList.toggle('is-busy', submittingDownload);
    elements.downloadButton.setAttribute('aria-busy', String(submittingDownload));
    elements.cancelButton.hidden = !activeTaskId && !cancelling;
    elements.cancelButton.disabled = !activeTaskId || cancelling;
    elements.cancelButton.textContent = cancelling ? '正在取消…' : '取消下载';
    elements.progressCard.dataset.state = downloadWork ? 'running'
      : elements.progressContent.hidden ? 'idle' : 'finished';
  }

  function updateAuthControls() {
    const downloadWork = hasDownloadWork();
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
    elements.deleteCredentialsConfirm.disabled = elements.credentialsDelete.hidden || elements.credentialsDelete.disabled;
    elements.clearSessionConfirm.disabled = elements.logoutButton.hidden || elements.logoutButton.disabled;
  }

  function updateControls() {
    updateParseControls();
    updateDownloadControls();
    updateAuthControls();
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
      for (const item of batch.items) {
        batch.controls.rows.get(item.itemIndex).checkbox.disabled = submittingDownload || item.pending;
      }
    }
  }

  function applyFailedBatch(snapshot) {
    if (!snapshot || typeof snapshot.taskId !== 'string' || !Array.isArray(snapshot.items)) return;
    if (Number.isInteger(snapshot.revision)) {
      if (snapshot.revision <= (failedBatchRevisions.get(snapshot.taskId) ?? -1)) return;
      failedBatchRevisions.set(snapshot.taskId, snapshot.revision);
    }
    let batch = failedBatches.get(snapshot.taskId);
    if (!snapshot.items.length) {
      const restoreFocus = batch?.controls.group.contains(document.activeElement);
      batch?.controls.group.remove();
      failedBatches.delete(snapshot.taskId);
      failedBatchRevisions.delete(snapshot.taskId);
      if (restoreFocus) {
        const next = failedBatches.values().next().value;
        const target = next && !next.controls.all.disabled ? next.controls.all : elements.progressStatus;
        target.focus({ preventScroll: true });
      }
    } else {
      if (!batch) {
        if (failedBatches.size >= MAX_FAILED_BATCHES) {
          const oldest = failedBatches.keys().next().value;
          const group = failedBatches.get(oldest).controls.group;
          if (group.contains(document.activeElement)) elements.progressStatus.focus({ preventScroll: true });
          group.remove();
          failedBatches.delete(oldest);
          failedBatchRevisions.delete(oldest);
        }
        batch = { selected: new Set() };
        failedBatches.set(snapshot.taskId, batch);
      }
      Object.assign(batch, snapshot);
      const available = new Set(batch.items.filter((item) => !item.pending).map((item) => item.itemIndex));
      for (const index of batch.selected) if (!available.has(index)) batch.selected.delete(index);
    }
    renderFailedBatches(snapshot.items.length ? batch : null);
  }

  function createFailedBatchControls(batch) {
    const group = document.createElement('section');
    group.className = 'failed-batch';
    const heading = document.createElement('h3');
    const context = document.createElement('p');
    context.className = 'failed-batch-context';
    const allLabel = document.createElement('label');
    allLabel.className = 'failed-select-all';
    const all = document.createElement('input');
    all.type = 'checkbox';
    const allText = document.createElement('span');
    allText.textContent = '全选可重试项';
    all.addEventListener('change', () => {
      batch.selected.clear();
      if (all.checked) batch.items.filter((item) => !item.pending).forEach((item) => batch.selected.add(item.itemIndex));
      renderFailedBatches(batch);
    });
    allLabel.append(all, allText);
    const list = document.createElement('ul');
    list.className = 'failed-items';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button button-outline button-block';
    retry.addEventListener('click', () => retryFailedBatch(batch));
    group.dataset.testid = 'failed-batch';
    group.append(heading, context, allLabel, list, retry);
    elements.failedBatches.append(group);
    return { group, heading, context, all, list, retry, rows: new Map() };
  }

  function createFailedItem(batch, index) {
    const row = document.createElement('li');
    row.dataset.testid = 'failed-item';
    const label = document.createElement('label');
    label.className = 'failed-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) batch.selected.add(index);
      else batch.selected.delete(index);
      updateFailedControls();
    });
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    const error = document.createElement('span');
    error.className = 'failed-item-error';
    copy.append(title, error);
    label.append(checkbox, copy);
    row.append(label);
    return { row, checkbox, title, error };
  }

  function renderFailedBatches(batch) {
    if (batch) {
      const view = batch.controls ||= createFailedBatchControls(batch);
      setText(view.heading, `${batch.title || '未命名下载任务'} · ${batch.items.length} 项未成功`);
      setText(view.context, [formatQuality(batch.formatId), batch.directory].filter(Boolean).join(' · '));
      const indices = new Set(batch.items.map((item) => item.itemIndex));
      const focused = document.activeElement;
      const scrollTop = view.list.scrollTop;
      for (const [index, controls] of view.rows) {
        if (indices.has(index)) continue;
        controls.row.remove();
        view.rows.delete(index);
      }
      batch.items.forEach((item, position) => {
        let controls = view.rows.get(item.itemIndex);
        if (!controls) {
          controls = createFailedItem(batch, item.itemIndex);
          view.rows.set(item.itemIndex, controls);
        }
        const sibling = view.list.children[position];
        if (sibling !== controls.row) view.list.insertBefore(controls.row, sibling || null);
        controls.checkbox.checked = batch.selected.has(item.itemIndex);
        setText(controls.title, `第 ${item.itemIndex} 条 · ${item.title || '未命名视频'}`);
        setText(controls.error, item.pending ? '已加入重新下载队列…' : item.error || '下载失败');
      });
      if (view.list.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
      view.list.scrollTop = scrollTop;
    }
    elements.failedDownloads.hidden = failedBatches.size === 0;
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
    authState = (result?.loginState || '') + '/' + Boolean(Number(result?.cookieCount) > 0);
    if (result && result.loginState === 'error') {
      elements.sessionPill.dataset.state = 'unverified';
      elements.sessionLabel.textContent = '暂无法读取会话';
      elements.sessionSummary.textContent = '状态暂不可用';
      elements.sessionSummary.dataset.state = 'unverified';
      elements.loginHelp.textContent = '暂无法检查网站登录状态。解析和下载仍会尝试使用已保存的会话。';
      elements.logoutButton.hidden = true;
      updateAuthControls();
      return;
    }
    const saved = Number(result?.cookieCount) > 0;
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
    updateAuthControls();
  }

  function applySessionStatus(result) {
    if (!acceptAuthRevision(result?.revision)) return false;
    setSession(result);
    return true;
  }

  function updatePerformerSelection() {
    selectedItemIndices = performerChecks.flatMap((checkbox, index) => checkbox.checked ? [index + 1] : []);
    const total = performerChecks.length;
    const count = selectedItemIndices.length;
    elements.performerAll.checked = total > 0 && count === total;
    elements.performerAll.indeterminate = count > 0 && count < total;
    elements.performerCount.textContent = `已选 ${count} / ${total} 条`;
    updateDownloadControls();
  }

  function showPerformerEntries(entries) {
    elements.performerHeading.append(elements.videoDetails);
    const rows = document.createDocumentFragment();
    performerChecks = entries.map((entry) => {
      const row = document.createElement('label');
      row.className = 'performer-entry';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = entry.title;
      const url = document.createElement('span');
      url.className = 'performer-url';
      url.textContent = entry.url;
      copy.append(title, url);
      row.append(checkbox, copy);
      rows.append(row);
      return checkbox;
    });
    elements.performerEntries.replaceChildren(rows);
    elements.performerDetails.open = true;
    elements.performerDetails.hidden = false;
    elements.performerCount.hidden = false;
    updatePerformerSelection();
  }

  function clearResource() {
    if (parsedResource?.kind === 'pornstar') {
      elements.videoPreview.append(elements.videoDetails);
      elements.performerDetails.hidden = true;
      elements.performerCount.hidden = true;
      elements.performerEntries.replaceChildren();
      performerChecks = [];
      selectedItemIndices = [];
    }
    parsedResource = null;
    setVideoConcurrency();
    elements.mainColumn.classList.remove('has-resource');
    elements.videoEmpty.hidden = false;
    elements.videoDetails.hidden = true;
    elements.formatRow.hidden = true;
    elements.concurrencyCard.hidden = true;
    elements.parsedTitle.textContent = '';
    elements.parsedTitle.title = '';
    elements.videoMeta.textContent = '';
    elements.resourceKind.textContent = '已解析的内容';
    elements.thumbnailPlaceholder.classList.remove('is-batch');
    elements.thumbnail.removeAttribute('src');
    elements.thumbnail.hidden = true;
    elements.thumbnailPlaceholder.hidden = false;
    elements.formatSelect.replaceChildren();
    updateParseControls();
    updateDownloadControls();
  }

  function showResource(resource) {
    parsedResource = resource;
    elements.mainColumn.classList.add('has-resource');
    const kind = kindNames[resource.kind] || kindNames.video;
    const isBatch = resource.kind === 'playlist' || resource.kind === 'pornstar';
    setVideoConcurrency();
    elements.resourceKind.textContent = `已解析的${kind}`;
    elements.thumbnailPlaceholder.classList.toggle('is-batch', isBatch);
    const title = typeof resource.title === 'string' && resource.title.trim() ? resource.title : `未命名${kind}`;
    elements.parsedTitle.textContent = title;
    elements.parsedTitle.title = title;
    const count = Number(resource.entryCount);
    const details = [kind, resource.kind === 'playlist' && Number.isInteger(count) ? `${count} 条视频` : '',
      resource.id ? `ID ${String(resource.id)}` : '', !isBatch ? formatDuration(resource.duration) : ''].filter(Boolean);
    elements.videoMeta.textContent = details.join(' · ');

    const thumbnail = safeThumbnailUrl(resource.thumbnail);
    elements.thumbnail.hidden = !thumbnail;
    elements.thumbnailPlaceholder.hidden = Boolean(thumbnail);
    if (thumbnail) elements.thumbnail.src = thumbnail;
    else elements.thumbnail.removeAttribute('src');

    const choices = Array.isArray(resource.formats) ? resource.formats : [];
    const options = document.createDocumentFragment();
    for (const format of choices) {
      if (!format || format.id == null) continue;
      const option = document.createElement('option');
      option.value = String(format.id);
      option.textContent = typeof format.label === 'string' && format.label.trim()
        ? format.label
        : [format.height ? `${format.height}p` : '', format.ext || ''].filter(Boolean).join(' · ') || String(format.id);
      options.append(option);
    }
    elements.formatSelect.replaceChildren(options);
    elements.videoEmpty.hidden = true;
    if (resource.kind === 'pornstar') showPerformerEntries(resource.entries);
    elements.videoDetails.hidden = false;
    elements.formatRow.hidden = false;
    elements.concurrencyCard.hidden = false;
    updateDownloadControls();
  }

  function setProgress(percent, status, detail) {
    const numeric = Number(percent);
    const bounded = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
    elements.progressEmpty.hidden = true;
    elements.progressContent.hidden = false;
    setText(elements.progressStatus, status);
    setText(elements.progressPercent, `${Math.round(bounded)}%`);
    elements.progressFill.style.width = `${bounded}%`;
    elements.progressTrack.setAttribute('aria-valuenow', String(Math.round(bounded)));
    setText(elements.progressDetail, detail);
  }

  function setProgressItem(event) {
    const resource = activeDownloadResource;
    if (!resource || resource.kind === 'video') {
      elements.progressItem.hidden = true;
      setText(elements.progressItem, '');
      return;
    }
    const activeVideos = Array.isArray(event && event.activeVideos)
      ? event.activeVideos.filter((video) => Number.isInteger(video.itemIndex) && video.itemIndex > 0)
      : [];
    if (activeVideos.length > 1) {
      // Concurrent workers report progress independently. Keep the headline steady
      // instead of replacing it with whichever video's event arrived last; the
      // ordered rows below carry each video's live title, speed, and ETA.
      setText(elements.progressItem, `当前并发下载：${activeVideos.length} 条视频`);
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
    setText(elements.progressItem, title ? `${position} · ${title}${retry}` : `${position}${retry}`);
    elements.progressItem.hidden = false;
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
        || !acceptLoginWindowRevision(state.revision)) return false;
    loginWindowOpen = state.windowOpen;
    updateAuthControls();
    return true;
  }

  async function openLogin() {
    if (!api || loginBusy) return;
    loginBusy = true;
    updateAuthControls();
    try {
      const result = await api.openLogin();
      if (applyLoginWindowState(result) && loginWindowOpen) {
        showNotice('登录窗口已打开。完成登录后会自动确认并关闭；若被遮住，可点击“显示登录窗口”。');
      }
    } catch (error) {
      showNotice(`打开登录窗口失败：${errorMessage(error)}`, 'error');
    } finally {
      loginBusy = false;
      updateAuthControls();
    }
  }

  function onLoginClosed(result) {
    if (!applySessionStatus(result)) return;
    sessionRevision++;
    if (!hasDownloadWork() && parseAuthState !== authState && (parsedResource || parsing)) {
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
    updateAuthControls();
  }

  async function logout() {
    if (!api || loginBusy) return;
    loginBusy = true;
    updateAuthControls();
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
      updateAuthControls();
    }
  }

  function setCredentialsStatus(result) {
    elements.credentialsRefresh.hidden = true;
    credentialsReady = true;
    credentialsAvailable = Boolean(result && result.available);
    credentialsSaved = Boolean(result && result.saved);
    credentialsUnreadable = Boolean(result && result.error);
    updateAuthControls();
  }

  async function refreshCredentials() {
    const revision = ++credentialsRevision;
    elements.credentialsRefresh.disabled = true;
    try {
      const result = await api.credentialsStatus();
      if (revision === credentialsRevision) setCredentialsStatus(result);
    } catch (error) {
      if (revision !== credentialsRevision) return;
      elements.credentialsRefresh.hidden = false;
      showNotice(`读取保存的账号密码失败：${errorMessage(error)}`, 'error');
    } finally {
      if (revision === credentialsRevision) elements.credentialsRefresh.disabled = false;
    }
  }

  function loadInitialAccountState() {
    if (typeof api.credentialsStatus === 'function') refreshCredentials();
    const initialSessionRevision = sessionRevision;
    api.sessionStatus().then((result) => {
      if (sessionRevision === initialSessionRevision) applySessionStatus(result);
    }).catch((error) => {
      if (sessionRevision !== initialSessionRevision) return;
      setSession({ loginState: 'error' });
      showNotice(`读取会话失败：${errorMessage(error)}`, 'error');
    });
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
    updateAuthControls();
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
      updateAuthControls();
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
    parseAuthState = authState;
    clearResource();
    hideNotice();
    parsing = true;
    updateParseControls();
    updateDownloadControls();
    try {
      const resource = await api.parse(url);
      if (generation !== parseGeneration || elements.urlInput.value.trim() !== url) return;
      if (!resource || !Array.isArray(resource.formats) || resource.formats.length === 0) {
        throw new Error('没有找到可下载的画质。');
      }
      if ((resource.kind === 'playlist' || resource.kind === 'pornstar') && Number(resource.entryCount) <= 0) {
        throw new Error('没有找到可下载的视频。');
      }
      if (resource.kind === 'pornstar' && (!Array.isArray(resource.entries) || resource.entries.length !== resource.entryCount)) {
        throw new Error('明星视频列表不完整，请重新解析。');
      }
      if (typeof resource.snapshotId !== 'string' || !resource.snapshotId) throw new Error('无法识别解析结果，请重新解析。');
      showResource(resource);
    } catch (error) {
      if (generation === parseGeneration) showNotice(`解析失败：${errorMessage(error)}`, 'error');
    } finally {
      if (generation === parseGeneration) {
        parsing = false;
        updateParseControls();
        updateDownloadControls();
      }
    }
  }

  async function selectDirectory() {
    if (!api || directoryLoading || selectingDirectory) return;
    selectingDirectory = true;
    updateDownloadControls();
    try {
      const selected = await api.selectDirectory();
      if (typeof selected === 'string' && selected.trim()) {
        directory = selected;
        elements.directoryLabel.textContent = selected;
        elements.directoryLabel.title = selected;
        elements.directoryPath.classList.add('has-value');
      }
    } catch (error) {
      showNotice(`选择文件夹失败：${errorMessage(error)}`, 'error');
    } finally {
      selectingDirectory = false;
      updateDownloadControls();
    }
  }

  function activateDownload(task) {
    delete elements.progressCard.dataset.outcome;
    activeTaskId = task.taskId;
    activeDownloadResource = task.resource;
    task.state = 'downloading';
    addTaskToHistory(task);
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
    if (resource.kind === 'pornstar' && !selectedItemIndices.length) return;
    const request = {
      snapshotId: resource.snapshotId,
      formatId: elements.formatSelect.value,
      fragmentConcurrency: Number(elements.fragmentConcurrency.value),
      videoConcurrency: resource.kind === 'video' ? concurrencyOptions.video[0] : Number(batchVideoConcurrency),
      directory,
    };
    if (resource.kind === 'pornstar') {
      request.itemIndices = selectedItemIndices;
      await submitDownload(request, { kind: resource.kind, title: resource.title, entryCount: selectedItemIndices.length });
    } else {
      await submitDownload(request, resource);
    }
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
      const items = new Map((task.items || []).map((item) => [item.itemIndex, { ...item, state: 'queued' }]));
      const { kind, title, entryCount } = resource;
      const downloadTask = { taskId: task.taskId, resource: { kind, title, entryCount }, retry, items, state: 'queued' };
      downloadTasks.set(task.taskId, downloadTask);
      queuedTasks.push(downloadTask);
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
    flushDownloadProgress();
    const task = downloadTasks.get(taskId);
    cancelling = true;
    renderTaskSummary(task);
    elements.progressStatus.textContent = '正在取消';
    elements.progressDetail.textContent = '正在停止下载任务…';
    updateControls();
    try {
      if (await api.cancel(taskId) !== false) return;
      throw new Error('该任务已结束。');
    } catch (error) {
      if (activeTaskId !== taskId) return;
      cancelling = false;
      flushDownloadProgress();
      renderTaskSummary(task);
      if (task.latestActivity) renderDownloadActivity(task.latestActivity);
      else setProgress(task.percent || 0, '正在下载', '正在连接媒体服务器…');
      showNotice(`取消下载失败：${errorMessage(error)}`, 'error');
      updateControls();
    }
  }

  function renderActiveVideos(videos) {
    const nextRows = new Map();
    for (const video of videos) {
      if (!Number.isInteger(video.itemIndex) || video.itemIndex < 1) continue;
      let controls = activeVideoRows.get(video.itemIndex);
      if (!controls) {
        const row = document.createElement('div');
        row.className = 'download-list-row progress-video';
        row.dataset.testid = 'progress-item';
        row.setAttribute('role', 'listitem');
        const title = document.createElement('span');
        title.className = 'progress-video-title';
        const speed = document.createElement('span');
        speed.className = 'progress-video-speed';
        const eta = document.createElement('span');
        eta.className = 'progress-video-eta';
        row.append(title, speed, eta);
        controls = { row, title, speed, eta };
      }
      const title = typeof video.title === 'string' && video.title.trim() ? video.title : '未命名视频';
      const speed = typeof video.speed === 'string' && video.speed ? video.speed : '测速中…';
      const eta = typeof video.eta === 'string' && video.eta ? `剩余 ${video.eta}` : '';
      setText(controls.title, `第 ${video.itemIndex} 条 · ${title}`);
      setText(controls.speed, speed);
      setText(controls.eta, eta);
      if (controls.eta.hidden !== !eta) controls.eta.hidden = !eta;
      nextRows.set(video.itemIndex, controls);
    }
    const children = elements.progressVideos.children;
    const rows = [...nextRows.values()].map(({ row }) => row);
    if (children.length !== rows.length || rows.some((row, index) => children[index] !== row)) {
      elements.progressVideos.replaceChildren(...rows);
    }
    elements.progressVideos.hidden = rows.length === 0;
    activeVideoRows = nextRows;
  }

  function paintDownloadProgress() {
    progressFrame = null;
    if (!pendingProgress) return;
    const event = pendingProgress;
    pendingProgress = null;
    const task = downloadTasks.get(event.taskId);
    for (const itemIndex of changedProgressItems) renderTaskItem(task.view, task.items.get(itemIndex));
    changedProgressItems.clear();
    if (task.view) renderTaskSummary(task);
    if (!cancelling) renderDownloadActivity(event);
  }

  function flushDownloadProgress() {
    if (progressFrame !== null) window.cancelAnimationFrame(progressFrame);
    paintDownloadProgress();
  }

  function onDownloadEvent(event) {
    if (!event || typeof event.taskId !== 'string') return;
    if (event.taskId !== activeTaskId) {
      const queuedIndex = queuedTasks.findIndex((task) => task.taskId === event.taskId);
      if (queuedIndex >= 0) {
        if (event.type === 'started' && !activeTaskId) {
          const [task] = queuedTasks.splice(queuedIndex, 1);
          task.percent = event.percent;
          activateDownload(task);
          return;
        } else if (terminalDownloadStates.includes(event.type)) {
          const [task] = queuedTasks.splice(queuedIndex, 1);
          updateTaskDetails(task, event);
          addTaskToHistory(task);
          recordFinishedTask(task.taskId);
          applyFailedBatch(event.failedBatch);
          updateControls();
          return;
        } else {
          return;
        }
      } else if (submittingDownload && !downloadTasks.has(event.taskId)) {
        if (event.type === 'progress') {
          const item = event.itemUpdate;
          pendingDownloadEvents = pendingDownloadEvents.filter((pending) => {
            if (pending.taskId !== event.taskId || pending.type !== 'progress') return true;
            const earlier = pending.itemUpdate;
            if (!earlier || !item) return Boolean(earlier || item);
            return earlier.state !== 'downloading' || item.state !== 'downloading'
              || earlier.itemIndex !== item.itemIndex || earlier.attempt !== item.attempt;
          });
        }
        pendingDownloadEvents.push(event);
        return;
      } else {
        return;
      }
    }
    if (event.type === 'started') return;
    const task = downloadTasks.get(event.taskId);
    const periodicProgress = event.type === 'progress'
      && (!event.itemUpdate || event.itemUpdate.state === 'downloading');
    if (periodicProgress && typeof window.requestAnimationFrame === 'function') {
      // Keep the latest state of every item, while painting at most once per frame.
      updateTaskDetails(task, event, true);
      pendingProgress = event;
      if (progressFrame === null) progressFrame = window.requestAnimationFrame(paintDownloadProgress);
      return;
    }
    flushDownloadProgress();
    updateTaskDetails(task, event);
    if (event.type === 'progress' || event.type === 'retry') {
      if (!cancelling) renderDownloadActivity(event);
    } else {
      finishDownload(event);
    }
  }

  function renderDownloadActivity(event) {
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
    const status = hasActivitySummary && activeCount > 0 ? '正在下载' : '等待重试';
    const retryDetailText = hasActivitySummary
      ? [detail, activeCount > 0 ? '失败项已加入重试队列' : '等待重试任务启动'].filter(Boolean).join(' · ')
      : event.message || '已加入队列末尾。';
    setProgress(event.percent, status, retryDetailText);
    setProgressItem(event);
  }

  function finishDownload(event) {
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
    elements.progressCard.dataset.outcome = event.type;
    applyFailedBatch(event.failedBatch);
    recordFinishedTask(event.taskId);
    finishProgressItem(event, counts);
    renderActiveVideos([]);
    activeTaskId = null;
    activeDownloadResource = null;
    cancelling = false;
    updateControls();
    if (event.type === 'cancelled') setText(elements.queueAnnouncement, event.message || '下载任务已取消。');
  }

  elements.noticeClose.addEventListener('click', hideNotice);
  elements.loginButton.addEventListener('click', openLogin);
  elements.credentialsRefresh.addEventListener('click', refreshCredentials);
  elements.credentialsSave.addEventListener('click', () => changeCredentials('save'));
  elements.credentialsFill.addEventListener('click', () => changeCredentials('fill'));
  bindConfirmation(elements.credentialsDelete, elements.deleteCredentialsDialog,
    elements.deleteCredentialsCancel, () => changeCredentials('delete'),
    () => elements.credentialsSave.disabled ? elements.loginButton : elements.credentialsSave);
  bindConfirmation(elements.logoutButton, elements.clearSessionDialog, elements.clearSessionCancel, logout, elements.loginButton);
  elements.parseForm.addEventListener('submit', parseResource);
  function handleUrlInput() {
    if (composingUrl) return;
    elements.urlInput.removeAttribute('aria-invalid');
    elements.urlHelp.textContent = urlHelpText;
    parseGeneration++;
    parsing = false;
    clearResource();
  }
  elements.urlInput.addEventListener('input', handleUrlInput);
  elements.urlInput.addEventListener('compositionstart', () => { composingUrl = true; });
  elements.urlInput.addEventListener('compositionend', () => {
    composingUrl = false;
    handleUrlInput();
  });
  elements.urlClear.addEventListener('click', () => {
    elements.urlInput.value = '';
    elements.urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    elements.urlInput.focus();
  });
  elements.formatSelect.addEventListener('change', updateDownloadControls);
  elements.performerAll.addEventListener('change', () => {
    for (const checkbox of performerChecks) checkbox.checked = elements.performerAll.checked;
    updatePerformerSelection();
  });
  elements.performerEntries.addEventListener('change', updatePerformerSelection);
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

  disposers.push(api.onDownloadEvent(onDownloadEvent));
  disposers.push(api.onLoginClosed(onLoginClosed));
  disposers.push(api.onLoginWindowChanged?.(applyLoginWindowState));
  Promise.resolve().then(() => api.concurrencyOptions()).then(configureConcurrency).catch((error) => {
    configureConcurrency({ fragment: [1, 4], video: [1, 2], defaults: { fragment: 1, video: 1 } });
    showNotice(`读取下载并发设置失败，已使用默认设置：${errorMessage(error)}`, 'error');
  });
  if (typeof api.onSessionStatusChanged === 'function') {
    disposers.push(api.onSessionStatusChanged((result) => {
      if (!applySessionStatus(result)) return;
      sessionRevision++;
    }));
  }
  if (typeof api.credentialsStatus === 'function' && typeof api.onCredentialsChanged === 'function') {
    disposers.push(api.onCredentialsChanged((result) => {
      credentialsRevision++;
      setCredentialsStatus(result);
    }));
  }
  elements.directoryLabel.textContent = '正在读取保存目录…';
  api.getDirectory().then((selected) => {
    if (typeof selected !== 'string' || !selected.trim()) throw new Error('没有可用的默认保存目录。');
    directory = selected;
    elements.directoryLabel.textContent = selected;
    elements.directoryLabel.title = selected;
    elements.directoryPath.classList.add('has-value');
  }).catch((error) => {
    elements.directoryLabel.textContent = '请选择保存目录';
    elements.directoryLabel.title = '';
    showNotice(`读取保存目录失败：${errorMessage(error)}`, 'error');
  }).finally(() => {
    directoryLoading = false;
    updateDownloadControls();
  });
  if (typeof window.requestAnimationFrame === 'function') {
    // The form and its handlers are ready before opening the saved account session.
    window.requestAnimationFrame(() => setTimeout(loadInitialAccountState, 0));
  } else {
    loadInitialAccountState();
  }
})();
