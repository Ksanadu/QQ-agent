'use strict';
// Reuse the existing business handlers; only desktop presentation/lifecycle is adapted.
const desktopTitles = { sessions: ['01','会话'], memory: ['02','记忆'], usage: ['03','用量'],
  skills: ['04','技能与插件'], snowluma: ['05','SnowLuma'], settings: ['06','设置'] };
let desktopVersion = '…';
const desktopRailToggle = $('#desktop-rail-toggle');
let desktopRailTouched = false, desktopRailSave = Promise.resolve();
function setDesktopRailCollapsed(collapsed) {
  document.body.dataset.railCollapsed = String(collapsed);
  desktopRailToggle.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? '展开侧栏' : '收起侧栏';
  desktopRailToggle.setAttribute('aria-label', label);
  desktopRailToggle.title = label;
}
desktopRailToggle.addEventListener('click', () => {
  desktopRailTouched = true;
  const collapsed = document.body.dataset.railCollapsed !== 'true';
  setDesktopRailCollapsed(collapsed);
  // Serialize writes so rapid reversals cannot persist an older click last.
  desktopRailSave = desktopRailSave.catch(() => {}).then(() => api('/desktop/api/preferences', {
    method: 'POST', body: JSON.stringify({ railCollapsed: collapsed })
  }));
  desktopRailSave.catch(error => showAppAlert('侧栏状态未保存：' + error.message));
});
$$('#tabs .tab').forEach(tab => {
  const label = tab.querySelector('span').textContent;
  tab.title = label; tab.setAttribute('aria-label', label);
});
const webApi = api;
function desktopOffline(error) {
  $('#desktop-connection').textContent = '后台未连接 ↗';
  $('#onebot-dot').className = 'dot dot-off';
  $('#onebot-label').textContent = '后台未连接';
  $('#model-label').textContent = '模型：—';
  $$('#readiness-dots .rdot').forEach(dot => { dot.className = 'rdot'; });
  const banner = $('#banner');
  banner.classList.remove('hidden');
  banner.innerHTML = `无法连接机器人后台：${esc(error.message)} <button class="btn btn-small" id="desktop-reconnect">更改连接</button>`;
  $('#desktop-reconnect').addEventListener('click', () => $('#desktop-connection').click());
}
api = async function (route, options) {
  try {
    const result = await webApi(route, options);
    if (route === '/api/status') $('#desktop-connection').innerHTML = '0.4.2 后台 <span>↗</span>';
    return result;
  } catch (error) {
    if (route === '/api/status' || route === '/desktop/api/runtime') desktopOffline(error);
    throw error;
  }
};
const webSwitchTab = switchTab;
switchTab = function (name) {
  webSwitchTab(name);
  const page = desktopTitles[state.tab] || desktopTitles.sessions;
  $('#desktop-page-title').textContent = page[1];
  $('#desktop-page-index').textContent = page[0];
  $$('#tabs .tab').forEach(tab => tab.setAttribute('aria-current', tab.dataset.tab === state.tab ? 'page' : 'false'));
};
bootLoop = async function () {
  setLoadingStatus('连接机器人后台…');
  const runtime = await api('/desktop/api/runtime');
  desktopVersion = runtime.version;
  $('#desktop-version').textContent = desktopVersion;
};
runUpdateCheck = async function () {}; // A desktop update must not install a new robot core.
const webDesktopSection = renderDesktopSection;
renderDesktopSection = function (config) {
  return webDesktopSection(config)
    .replace('开机自启</label>', '桌面开机自启</label>')
    .replace('用户数据目录</label>', '机器人数据目录</label>')
    .replace(/<h3>版本更新<\/h3>[\s\S]*$/, `<h3>桌面版本</h3><div class="field"><span>QQ Agent Desktop ${esc(desktopVersion)}</span></div>`);
};
const webOnebotSection = renderOnebotSection;
renderOnebotSection = function (config) {
  return webOnebotSection(config).replace('QQ Agent 启动时自动拉起 SnowLuma', '机器人后台启动时自动拉起 SnowLuma')
    .replace('改完 OneBot 地址需要重启应用生效', '改完 OneBot 地址需要重启机器人后台生效');
};
// The shutdown worker survives the backend. Open its transcript in an isolated
// native window rather than navigating this console (and its preload) away.
openShutdownDialog = async function () {
  if (shutdownInProgress || !(await uiConfirm('确认停机并中止当前所有会话？'))) return;
  shutdownInProgress = true;
  try {
    flushSettingsSaves();
    await waitDesktopSaves();
    const job = await api('/api/shutdown', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    await window.qqAgentShell.openShutdownLog(job);
  } catch (error) { showAppAlert('停机未完成：' + error.message); }
  finally { shutdownInProgress = false; }
};
$('#desktop-quit').addEventListener('click', () => window.qqAgentShell?.quit());
$$('.desktop-readiness').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.open)));
$('#desktop-refresh').addEventListener('click', () => { switchTab(state.tab); void refreshStatus(); });
const connectionDialog = $('#desktop-connection-dialog');
$('#desktop-connection').addEventListener('click', async () => {
  try {
    const preferences = await api('/desktop/api/preferences');
    $('#desktop-backend-url').value = preferences.backendUrl;
    $('#desktop-connection-error').textContent = '';
    connectionDialog.showModal();
  } catch (error) { showAppAlert(error.message); }
});
$('#desktop-connection-cancel').addEventListener('click', () => connectionDialog.close());
$('#desktop-connection-save').addEventListener('click', async () => {
  const button = $('#desktop-connection-save'); button.disabled = true;
  try {
    flushSettingsSaves();
    await waitDesktopSaves();
    await api('/desktop/api/preferences', { method: 'POST', body: JSON.stringify({ backendUrl: $('#desktop-backend-url').value }) });
    location.reload();
  } catch (error) { $('#desktop-connection-error').textContent = error.message; }
  finally { button.disabled = false; }
});
async function waitDesktopSaves() {
  await desktopRailSave.catch(() => {});
  const until = Date.now() + 9000;
  while (settingsGuard.pending) {
    if (Date.now() >= until) throw new Error('设置仍在保存，请稍后重试');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
window.qqAgentShell?.onPrepareLeave?.(async () => { flushSettingsSaves(); await waitDesktopSaves(); });
api('/desktop/api/preferences').then(prefs => {
  applyTheme(prefs.ui.theme);
  if (!desktopRailTouched) setDesktopRailCollapsed(prefs.railCollapsed === true);
}).catch(() => {});
