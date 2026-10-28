// Browser half of dsh-plugins-bridge: the "Plugins Bridge" page in Settings.
//
// Hand-written in the lazy-CJS module protocol used by the Web shell
// (`window.__ModuleLoader__.load` with a factory returning Cordis plugin
// exports), so the bundle needs no build step. The page depends on exactly one
// shell contract — `settings.section` — and on its own Host half's loopback
// management API. It renders its own markup and styles so it keeps working
// across shell refactors.
//
// The Host owns the truth (the bridge config file and the live plugin
// catalog); this half renders that truth, edits an in-memory draft, and saves
// it explicitly.
window.__ModuleLoader__.load({
  id: 'dsh-plugins-bridge',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var useCallback = React.useCallback;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useState = React.useState;

    var NS = 'dsh-plugins-bridge';
    var API = '/plugins-bridge/api';

    var DICT = {
      zh: {
        nav: '插件桥接',
        title: '插件桥接',
        description:
          '把所选插件的 API 与 Agent 工具通过受令牌保护的本地 HTTP 接口暴露给 Emacs、Vim 等外部编辑器。',
        refresh: '刷新',
        retry: '重试',
        loading: '正在载入插件与 API…',
        loadFailed: '载入失败',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        unsaved: '有未保存的修改',
        noChanges: '没有修改',
        bridgeStatus: '桥接状态',
        enabled: '已启用',
        disabled: '已停用',
        enableBridge: '启用桥接',
        enableHint: '关闭后，外部接口返回 503，但管理页仍可用。',
        baseUrl: '外部接口地址',
        token: '访问令牌',
        tokenHint: '外部程序必须携带 Authorization: Bearer <令牌>。请勿泄露或提交到仓库。',
        auth: '认证方式',
        configPath: '配置文件',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败',
        reveal: '显示',
        hide: '隐藏',
        regenerate: '重新生成',
        tokenConfirm: '重新生成后，使用旧令牌的外部程序会立即失去访问权限。继续吗？',
        tokenRegenerated: '令牌已重新生成',
        statsApiPackages: '含 API 的插件',
        statsEndpoints: '可调用接口',
        statsExposed: '已暴露插件',
        statsTools: 'Agent 工具',
        pluginsTitle: '选择要暴露的插件',
        pluginsHint:
          '列表来自当前运行中的 DSH 插件 API 反射。勾选后，该插件的全部非流式接口即可被外部调用；展开可查看参数与返回结构。',
        searchPlaceholder: '搜索插件名、包名或描述…',
        onlyApi: '只看含 API 的插件',
        showAll: '显示无 API 的插件',
        noPlugins: '当前部署没有可桥接的插件 API。',
        noSearchResults: '没有匹配的插件。',
        noApi: '此插件没有可调用的 API',
        endpointCount: '{n} 个接口',
        streamCount: '{n} 个流式接口',
        selectAll: '全选可见',
        clearAll: '清空选择',
        selectedCount: '已选 {n} 个插件',
        details: '查看接口',
        hideDetails: '收起接口',
        entries: '载入项',
        module: '模块',
        version: '版本',
        parameters: '参数',
        result: '返回',
        noParameters: '无参数',
        required: '必填',
        optional: '可选',
        streamUnsupported: '流式接口暂不桥接',
        requiresAgent: '需要 agentId',
        toolsTitle: 'Agent 工具',
        toolsHint: '把当前 Host 的模型工具（read、grep、subagent 等）一并暴露为 /v1/tools。',
        toolsCount: '当前可用 {n} 个工具',
        toolsExpose: '暴露 Agent 工具',
        toolsWarning:
          '工具会以你的身份在 DSH 进程中执行，可能读写文件或启动子进程。仅在你信任的编辑器环境中开启。',
        usageTitle: '调用示例',
        usageHint: '所有请求仅在本机回环地址上响应；除健康检查外都必须携带令牌。',
        usagePlugins: '列出已暴露的插件',
        usageInvoke: '调用一个接口',
        usageNote: 'agentId 可在 GET /v1/agents 中获取。',
        securityNote:
          '安全提示：桥接只监听回环地址，但任何能读取此页或配置文件的本地程序都能取得令牌。',
        requestFailed: '请求失败：{message}',
        notEnabled: '桥接已停用，外部调用会返回 503。',
        noSelection: '尚未暴露任何插件。勾选上方插件后保存。',
        phaseActive: '运行中',
        phaseLoading: '载入中',
        phasePending: '等待中',
        phaseFailed: '失败',
        phaseUnloading: '卸载中',
        disposed: '已释放',
        phaseDisposed: '已释放',
        unknown: '未知',
        showNoApi: '显示全部',
        hideNoApi: '只看含 API',
        configSavedAt: '已保存',
      },
      en: {
        nav: 'Plugins Bridge',
        title: 'Plugins Bridge',
        description:
          'Expose selected plugin APIs and agent tools over a token-protected local HTTP endpoint for Emacs, Vim, and other external editors.',
        refresh: 'Refresh',
        retry: 'Retry',
        loading: 'Loading plugins and APIs…',
        loadFailed: 'Failed to load',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        unsaved: 'Unsaved changes',
        noChanges: 'No changes',
        bridgeStatus: 'Bridge status',
        enabled: 'Enabled',
        disabled: 'Disabled',
        enableBridge: 'Enable bridge',
        enableHint: 'When off, external calls return 503 while this page stays available.',
        baseUrl: 'External API base URL',
        token: 'Access token',
        tokenHint: 'External programs must send Authorization: Bearer <token>. Do not share or commit it.',
        auth: 'Authentication',
        configPath: 'Config file',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        reveal: 'Reveal',
        hide: 'Hide',
        regenerate: 'Regenerate',
        tokenConfirm: 'Regenerating immediately revokes access for programs using the old token. Continue?',
        tokenRegenerated: 'Token regenerated',
        statsApiPackages: 'API plugins',
        statsEndpoints: 'Callable endpoints',
        statsExposed: 'Exposed plugins',
        statsTools: 'Agent tools',
        pluginsTitle: 'Choose plugins to expose',
        pluginsHint:
          'The list comes from the live DSH plugin API reflection. Selecting a plugin exposes all of its non-streaming endpoints; expand a row to inspect parameters and result schemas.',
        searchPlaceholder: 'Search title, package, or description…',
        onlyApi: 'Only plugins with an API',
        showAll: 'Show plugins without an API',
        noPlugins: 'This deployment exposes no bridgeable plugin APIs.',
        noSearchResults: 'No matching plugins.',
        noApi: 'This plugin has no callable API',
        endpointCount: '{n} endpoints',
        streamCount: '{n} streaming',
        selectAll: 'Select visible',
        clearAll: 'Clear selection',
        selectedCount: '{n} selected',
        details: 'Show endpoints',
        hideDetails: 'Hide endpoints',
        entries: 'Loader entries',
        module: 'Module',
        version: 'Version',
        parameters: 'Parameters',
        result: 'Result',
        noParameters: 'No parameters',
        required: 'required',
        optional: 'optional',
        streamUnsupported: 'Streaming endpoints are not bridged yet',
        requiresAgent: 'agentId required',
        toolsTitle: 'Agent tools',
        toolsHint: 'Also expose the Host’s model-facing tools (read, grep, subagent, …) as /v1/tools.',
        toolsCount: '{n} tools currently available',
        toolsExpose: 'Expose agent tools',
        toolsWarning:
          'Tools execute as you inside the DSH process and can read or write files and start subprocesses. Enable only in an editor environment you trust.',
        usageTitle: 'Usage',
        usageHint: 'Every request must come from this machine; all but the health check require the token.',
        usagePlugins: 'List exposed plugins',
        usageInvoke: 'Invoke one endpoint',
        usageNote: 'Find a session id with GET /v1/agents.',
        securityNote:
          'Security: the bridge listens on loopback only, but any local program that can read this page or the config file can obtain the token.',
        requestFailed: 'Request failed: {message}',
        notEnabled: 'The bridge is disabled; external calls return 503.',
        noSelection: 'No plugins are exposed yet. Select one above and save.',
        phaseActive: 'active',
        phaseLoading: 'loading',
        phasePending: 'pending',
        phaseFailed: 'failed',
        phaseUnloading: 'unloading',
        disposed: 'disposed',
        phaseDisposed: 'disposed',
        unknown: 'unknown',
        showNoApi: 'Show all',
        hideNoApi: 'Only with API',
        configSavedAt: 'Saved',
      },
    };

    var CSS = [
      '.dpb-root{display:flex;flex-direction:column;gap:18px;max-width:900px;padding:4px 2px 28px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.dpb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.dpb-head h2{margin:0 0 4px;font-size:15px;font-weight:600}',
      '.dpb-head p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;max-width:620px}',
      '.dpb-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '.dpb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;line-height:1.4;cursor:pointer;white-space:nowrap}',
      '.dpb-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dpb-btn:disabled{opacity:.45;cursor:default}',
      '.dpb-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.dpb-btn-primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-brand-primary)}',
      '.dpb-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:3px 6px}',
      '.dpb-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dpb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.dpb-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dpb-card-body{padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.dpb-card-title{font-size:13px;font-weight:600;margin:0}',
      '.dpb-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dpb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.dpb-code{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 7px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}',
      '.dpb-field{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}',
      '.dpb-field-label{width:92px;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;padding-top:3px}',
      '.dpb-field-value{flex:1;min-width:220px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dpb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}',
      '.dpb-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}',
      '.dpb-stat b{display:block;font-size:18px;font-weight:600;line-height:1.2}',
      '.dpb-stat span{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dpb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dpb-search{flex:1;min-width:180px;appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 9px;outline:none}',
      '.dpb-search:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dpb-list{display:flex;flex-direction:column;max-height:430px;overflow:auto}',
      '.dpb-plugin{border-bottom:1px solid var(--dsw-alias-border-l1);padding:10px 14px;display:flex;flex-direction:column;gap:6px}',
      '.dpb-plugin:last-child{border-bottom:none}',
      '.dpb-plugin-main{display:flex;align-items:flex-start;gap:9px;cursor:pointer;min-width:0}',
      '.dpb-plugin-main input{margin-top:2px;flex:none;accent-color:var(--dsw-alias-brand-primary)}',
      '.dpb-plugin-main input:disabled{cursor:default}',
      '.dpb-plugin-text{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}',
      '.dpb-plugin-title{font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dpb-plugin-pkg{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dpb-plugin-desc{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dpb-plugin-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding-left:23px}',
      '.dpb-badge{display:inline-flex;align-items:center;gap:3px;border-radius:999px;padding:1px 7px;font-size:10.5px;line-height:1.6;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap}',
      '.dpb-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.dpb-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}',
      '.dpb-badge-error{color:var(--dsw-alias-state-error-primary);border-color:currentColor}',
      '.dpb-badge-brand{color:var(--dsw-alias-brand-primary);border-color:currentColor}',
      '.dpb-detail{margin:4px 0 2px 23px;border-left:2px solid var(--dsw-alias-border-l1);padding:6px 0 2px 12px;display:flex;flex-direction:column;gap:8px}',
      '.dpb-endpoint{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;background:var(--dsw-alias-bg-base)}',
      '.dpb-endpoint-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dpb-endpoint-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;font-weight:600;overflow-wrap:anywhere}',
      '.dpb-endpoint-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;overflow-wrap:anywhere}',
      '.dpb-params{margin-top:6px;display:flex;flex-direction:column;gap:3px}',
      '.dpb-param{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;font-size:11.5px}',
      '.dpb-param-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:600}',
      '.dpb-param-desc{color:var(--dsw-alias-label-secondary)}',
      '.dpb-switch{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:12px}',
      '.dpb-switch input{accent-color:var(--dsw-alias-brand-primary)}',
      '.dpb-notice{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.dpb-error{color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}',
      '.dpb-warnbox{border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);border-radius:8px;padding:8px 10px;font-size:12px;background:transparent}',
      '.dpb-empty{padding:22px 14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dpb-pre{margin:0;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}',
      '.dpb-loading{padding:30px 14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dpb-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}',
      '.dpb-token-actions{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}',
      '.dpb-plugin.selected{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, transparent)}',
    ].join('');

    // ── locale plumbing ──────────────────────────────────────────────────

    var currentLang = 'zh';
    var listeners = new Set();

    /** Set the active language and notify mounted pages. */
    function setLang(next) {
      var normalized = next === 'en' ? 'en' : 'zh';
      if (normalized === currentLang) return;
      currentLang = normalized;
      listeners.forEach(function (listener) {
        try {
          listener(normalized);
        } catch (error) {
          console.warn('[dsh-plugins-bridge] language listener failed:', error);
        }
      });
    }

    /** Translate one key for a language. */
    function translate(language, key, params) {
      var table = DICT[language === 'en' ? 'en' : 'zh'];
      var text = table[key] !== undefined ? table[key] : DICT.zh[key] !== undefined ? DICT.zh[key] : key;
      if (params === undefined) return text;
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return params[name] !== undefined ? String(params[name]) : match;
      });
    }

    /** Subscribe a component to language changes. */
    function useLang() {
      var pair = useState(currentLang);
      var value = pair[0];
      var setValue = pair[1];
      useEffect(function () {
        listeners.add(setValue);
        return function () {
          listeners.delete(setValue);
        };
      }, []);
      return value;
    }

    // ── HTTP ─────────────────────────────────────────────────────────────

    /** Call the Host half's management API. */
    function api(route, options) {
      var opts = options || {};
      var params = new URLSearchParams();
      params.set('lang', currentLang);
      if (opts.query !== undefined) {
        Object.keys(opts.query).forEach(function (key) {
          if (opts.query[key] !== undefined) params.set(key, String(opts.query[key]));
        });
      }
      var isRead = opts.body === undefined;
      return fetch(API + route + '?' + params.toString(), {
        method: isRead ? 'GET' : 'POST',
        headers: isRead ? undefined : { 'content-type': 'application/json' },
        body: isRead ? undefined : JSON.stringify(opts.body),
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (payload) {
              if (!response.ok) {
                var error = new Error(
                  payload.error !== undefined && typeof payload.error.message === 'string'
                    ? payload.error.message
                    : 'HTTP ' + response.status,
                );
                error.code = payload.error !== undefined ? payload.error.code : undefined;
                error.status = response.status;
                throw error;
              }
              return payload;
            });
        })
        .catch(function (error) {
          if (error instanceof TypeError) {
            var wrapped = new Error(error.message);
            wrapped.code = 'network';
            throw wrapped;
          }
          throw error;
        });
    }

    /** Read a plugin's full endpoint detail. */
    function pluginDetail(packageName) {
      return api('/plugin', { query: { package: packageName } });
    }

    /** Copy text with a clipboard API fallback for older shells. */
    function copyText(text) {
      if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        try {
          var area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          var copied = document.execCommand('copy');
          document.body.removeChild(area);
          if (copied) resolve();
          else reject(new Error('copy failed'));
        } catch (error) {
          reject(error);
        }
      });
    }

    // ── presentational helpers ───────────────────────────────────────────

    /** A short type label for one JSON Schema node. */
    function schemaLabel(schema) {
      if (schema === null || typeof schema !== 'object') return 'json';
      if (typeof schema.type === 'string') return schema.type;
      if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return 'union';
      if (Array.isArray(schema.enum)) return 'enum';
      if (schema.properties !== undefined) return 'object';
      if (schema.items !== undefined) return 'array';
      return 'json';
    }

    /** Phase badge class. */
    function phaseClass(phase) {
      if (phase === 'active') return 'dpb-badge dpb-badge-ok';
      if (phase === 'failed') return 'dpb-badge dpb-badge-error';
      if (phase === 'loading' || phase === 'pending' || phase === 'unloading') return 'dpb-badge dpb-badge-warn';
      return 'dpb-badge';
    }

    /** Translate a phase id with a technical fallback. */
    function phaseText(language, phase) {
      if (phase === null || phase === undefined) return translate(language, 'unknown');
      var key = 'phase' + String(phase).charAt(0).toUpperCase() + String(phase).slice(1);
      var table = DICT[language === 'en' ? 'en' : 'zh'];
      return table[key] !== undefined ? table[key] : String(phase);
    }

    /** A small inline icon for buttons. */
    function Icon(props) {
      var paths = {
        copy: ['M5 5h6v9H5z', 'M3 3h6v1H3.5v9H2V3.5A.5.5 0 0 1 2.5 3z'],
        refresh: ['M13 8a5 5 0 1 1-1.5-3.6', 'M13 2v4H9'],
        plus: ['M8 3v10', 'M3 8h10'],
        minus: ['M3 8h10'],
        external: ['M9 2h5v5', 'M14 2 7 9', 'M12 9v4.5A.5.5 0 0 1 11.5 14h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H8'],
      };
      var list = paths[props.name] || [];
      return h(
        'svg',
        {
          width: props.size || 13,
          height: props.size || 13,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        list.map(function (d, index) {
          return h('path', { key: index, d: d });
        }),
      );
    }

    /** The inline state used by the page. */
    function draftFromState(state) {
      return {
        enabled: state.enabled,
        exposeTools: state.exposeTools,
        selected: new Set(state.exposedPackages),
      };
    }

    /** Structural equality of the draft and the saved state. */
    function isDirty(state, draft) {
      if (state === null || draft === null) return false;
      if (state.enabled !== draft.enabled) return true;
      if (state.exposeTools !== draft.exposeTools) return true;
      if (state.exposedPackages.length !== draft.selected.size) return true;
      for (var index = 0; index < state.exposedPackages.length; index += 1) {
        if (!draft.selected.has(state.exposedPackages[index])) return true;
      }
      return false;
    }

    // ── page ─────────────────────────────────────────────────────────────

    function BridgePage() {
      var lang = useLang();
      var t = function (key, params) {
        return translate(lang, key, params);
      };
      var statePair = useState(null);
      var state = statePair[0];
      var setState = statePair[1];
      var draftPair = useState(null);
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var loadingPair = useState(true);
      var loading = loadingPair[0];
      var setLoading = loadingPair[1];
      var errorPair = useState(null);
      var error = errorPair[0];
      var setError = errorPair[1];
      var savingPair = useState(false);
      var saving = savingPair[0];
      var setSaving = savingPair[1];
      var noticePair = useState(null);
      var notice = noticePair[0];
      var setNotice = noticePair[1];
      var queryPair = useState('');
      var query = queryPair[0];
      var setQuery = queryPair[1];
      var showAllPair = useState(false);
      var showAll = showAllPair[0];
      var setShowAll = showAllPair[1];
      var expandedPair = useState({});
      var expanded = expandedPair[0];
      var setExpanded = expandedPair[1];
      var revealPair = useState(false);
      var reveal = revealPair[0];
      var setReveal = revealPair[1];
      var mounted = useRef(true);

      useEffect(
        function () {
          return function () {
            mounted.current = false;
          };
        },
        [],
      );

      /** Fetch the management state. */
      var load = useCallback(
        function () {
          setLoading(true);
          setError(null);
          api('/state')
            .then(function (next) {
              if (!mounted.current) return;
              setState(next);
              setDraft(draftFromState(next));
              setLoading(false);
            })
            .catch(function (failure) {
              if (!mounted.current) return;
              setError(failure);
              setLoading(false);
            });
        },
        [],
      );

      useEffect(
        function () {
          load();
        },
        [load, lang],
      );

      useEffect(
        function () {
          if (notice === null) return undefined;
          var timer = setTimeout(function () {
            setNotice(null);
          }, 2600);
          return function () {
            clearTimeout(timer);
          };
        },
        [notice],
      );

      /** Save the draft as the bridge configuration. */
      var save = useCallback(
        function () {
          if (draft === null) return;
          setSaving(true);
          setError(null);
          api('/config', {
            body: {
              enabled: draft.enabled,
              exposeTools: draft.exposeTools,
              exposedPackages: Array.from(draft.selected),
            },
          })
            .then(function (next) {
              if (!mounted.current) return;
              setState(next);
              setDraft(draftFromState(next));
              setSaving(false);
              setExpanded({});
              setNotice(t('saved'));
            })
            .catch(function (failure) {
              if (!mounted.current) return;
              setSaving(false);
              setError(failure);
            });
        },
        [draft, t],
      );

      /** Regenerate the bearer token and save current draft values with it. */
      var regenerate = useCallback(
        function () {
          if (draft === null) return;
          if (!window.confirm(t('tokenConfirm'))) return;
          setSaving(true);
          setError(null);
          api('/config', {
            body: {
              enabled: draft.enabled,
              exposeTools: draft.exposeTools,
              exposedPackages: Array.from(draft.selected),
              regenerateToken: true,
            },
          })
            .then(function (next) {
              if (!mounted.current) return;
              setState(next);
              setDraft(draftFromState(next));
              setSaving(false);
              setReveal(true);
              setNotice(t('tokenRegenerated'));
            })
            .catch(function (failure) {
              if (!mounted.current) return;
              setSaving(false);
              setError(failure);
            });
        },
        [draft, t],
      );

      /** Copy text and report the outcome inline. */
      var copy = useCallback(
        function (text) {
          copyText(text)
            .then(function () {
              setNotice(t('copied'));
            })
            .catch(function () {
              setError(new Error(t('copyFailed')));
            });
        },
        [t],
      );

      /** Toggle one package in the draft. */
      var togglePackage = useCallback(function (packageName) {
        setDraft(function (current) {
          if (current === null) return current;
          var selected = new Set(current.selected);
          if (selected.has(packageName)) selected.delete(packageName);
          else selected.add(packageName);
          return { enabled: current.enabled, exposeTools: current.exposeTools, selected: selected };
        });
      }, []);

      /** Expand or collapse one plugin's endpoint detail. */
      var toggleDetail = useCallback(
        function (packageName) {
          var current = expanded[packageName];
          if (current !== undefined && current.loading !== true) {
            setExpanded(function (previous) {
              var next = Object.assign({}, previous);
              delete next[packageName];
              return next;
            });
            return;
          }
          setExpanded(function (previous) {
            return Object.assign({}, previous, { [packageName]: { loading: true } });
          });
          pluginDetail(packageName)
            .then(function (detail) {
              if (!mounted.current) return;
              setExpanded(function (previous) {
                return Object.assign({}, previous, { [packageName]: { loading: false, detail: detail } });
              });
            })
            .catch(function (failure) {
              if (!mounted.current) return;
              setExpanded(function (previous) {
                return Object.assign({}, previous, { [packageName]: { loading: false, error: failure.message } });
              });
            });
        },
        [expanded],
      );

      if (loading && state === null) {
        return h('div', { className: 'dpb-root' }, h('div', { className: 'dpb-loading' }, t('loading')));
      }
      if (error !== null && state === null) {
        return h(
          'div',
          { className: 'dpb-root' },
          h(
            'div',
            { className: 'dpb-card' },
            h(
              'div',
              { className: 'dpb-card-body' },
              h('div', { className: 'dpb-error' }, t('loadFailed') + '：' + error.message),
              h(
                'div',
                null,
                h(
                  'button',
                  { type: 'button', className: 'dpb-btn', onClick: load },
                  h(Icon, { name: 'refresh' }),
                  ' ',
                  t('retry'),
                ),
              ),
            ),
          ),
        );
      }
      if (state === null || draft === null) return h('div', { className: 'dpb-root' });

      var dirty = isDirty(state, draft);
      var visible = state.plugins.filter(function (row) {
        if (!showAll && row.endpointCount === 0 && !draft.selected.has(row.package)) return false;
        if (query.trim() === '') return true;
        var haystack = (row.title + ' ' + row.package + ' ' + (row.description || '')).toLowerCase();
        return haystack.indexOf(query.trim().toLowerCase()) >= 0;
      });
      var selectedWithApi = state.plugins.filter(function (row) {
        return draft.selected.has(row.package) && row.endpointCount > 0;
      });
      var exampleRow = selectedWithApi[0];
      var exampleEndpoint = exampleRow === undefined ? undefined : exampleRow.endpoints.filter(function (endpoint) {
        return endpoint.kind === 'unary';
      })[0];
      var exampleArgs = {};
      if (exampleEndpoint !== undefined && exampleEndpoint.requiresAgent !== null) {
        exampleArgs[exampleEndpoint.requiresAgent] = '<session-id>';
      }
      var exampleBody = {
        package: exampleRow === undefined ? '<package>' : exampleRow.package,
        endpoint: exampleEndpoint === undefined ? '<namespace>/<method>' : exampleEndpoint.endpoint,
        args: exampleArgs,
      };

      var saveButton = h(
        'button',
        {
          type: 'button',
          className: 'dpb-btn dpb-btn-primary',
          disabled: saving || !dirty,
          onClick: save,
          title: dirty ? t('unsaved') : t('noChanges'),
        },
        saving ? t('saving') : t('save'),
      );

      return h(
        'div',
        { className: 'dpb-root' },
        h('style', null, CSS),

        // Header
        h(
          'div',
          { className: 'dpb-head' },
          h(
            'div',
            null,
            h('h2', null, t('title')),
            h('p', null, t('description')),
          ),
          h(
            'div',
            { className: 'dpb-actions' },
            notice !== null ? h('span', { className: 'dpb-notice' }, notice) : null,
            dirty ? h('span', { className: 'dpb-muted' }, t('unsaved')) : null,
            h(
              'button',
              { type: 'button', className: 'dpb-btn dpb-btn-ghost', onClick: load, disabled: loading, title: t('refresh') },
              h(Icon, { name: 'refresh' }),
              ' ',
              t('refresh'),
            ),
            saveButton,
          ),
        ),

        error !== null
          ? h('div', { className: 'dpb-error' }, t('requestFailed', { message: error.message }))
          : null,

        !state.enabled
          ? h('div', { className: 'dpb-warnbox' }, t('notEnabled'))
          : null,

        // Stats
        h(
          'div',
          { className: 'dpb-stats' },
          stat(t('statsApiPackages'), state.stats.apiPackages),
          stat(t('statsEndpoints'), state.stats.endpoints),
          stat(t('statsExposed'), state.stats.exposed),
          stat(t('statsTools'), state.tools.count),
        ),

        // Status card
        h(
          'div',
          { className: 'dpb-card' },
          h(
            'div',
            { className: 'dpb-card-head' },
            h('h3', { className: 'dpb-card-title' }, t('bridgeStatus')),
            h(
              'label',
              { className: 'dpb-switch' },
              h('input', {
                type: 'checkbox',
                checked: draft.enabled,
                onChange: function (event) {
                  var value = event.target.checked;
                  setDraft(function (current) {
                    return current === null ? current : Object.assign({}, current, { enabled: value });
                  });
                },
              }),
              draft.enabled ? t('enabled') : t('disabled'),
            ),
          ),
          h(
            'div',
            { className: 'dpb-card-body' },
            h('div', { className: 'dpb-muted' }, t('enableHint')),
            field(
              t('baseUrl'),
              h('code', { className: 'dpb-code' }, state.baseUrl),
              h(
                'button',
                { type: 'button', className: 'dpb-btn dpb-btn-ghost', onClick: function () { copy(state.baseUrl); } },
                h(Icon, { name: 'copy' }),
                t('copy'),
              ),
            ),
            field(
              t('token'),
              h('code', { className: 'dpb-code' }, reveal ? state.token : state.tokenMasked),
              h(
                'span',
                { className: 'dpb-token-actions' },
                h(
                  'button',
                  { type: 'button', className: 'dpb-btn dpb-btn-ghost', onClick: function () { setReveal(!reveal); } },
                  reveal ? t('hide') : t('reveal'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dpb-btn dpb-btn-ghost', onClick: function () { copy(state.token); } },
                  h(Icon, { name: 'copy' }),
                  t('copy'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dpb-btn dpb-btn-ghost', onClick: regenerate, disabled: saving },
                  t('regenerate'),
                ),
              ),
            ),
            h('div', { className: 'dpb-muted' }, t('tokenHint')),
            field(t('configPath'), h('code', { className: 'dpb-code' }, state.configPath)),
            h('div', { className: 'dpb-muted' }, t('securityNote')),
          ),
        ),

        // Plugins
        h(
          'div',
          { className: 'dpb-card' },
          h(
            'div',
            { className: 'dpb-card-head' },
            h(
              'div',
              null,
              h('h3', { className: 'dpb-card-title' }, t('pluginsTitle')),
              h('div', { className: 'dpb-muted' }, t('selectedCount', { n: draft.selected.size })),
            ),
            h(
              'div',
              { className: 'dpb-actions' },
              h(
                'button',
                { type: 'button', className: 'dpb-btn dpb-btn-ghost', onClick: function () { setShowAll(!showAll); } },
                showAll ? t('hideNoApi') : t('showNoApi'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpb-btn dpb-btn-ghost',
                  onClick: function () {
                    setDraft(function (current) {
                      if (current === null) return current;
                      var selected = new Set(current.selected);
                      visible.forEach(function (row) {
                        if (row.endpointCount > 0) selected.add(row.package);
                      });
                      return Object.assign({}, current, { selected: selected });
                    });
                  },
                },
                t('selectAll'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpb-btn dpb-btn-ghost',
                  onClick: function () {
                    setDraft(function (current) {
                      return current === null ? current : Object.assign({}, current, { selected: new Set() });
                    });
                  },
                },
                t('clearAll'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dpb-card-body' },
            h('div', { className: 'dpb-muted' }, t('pluginsHint')),
            h(
              'div',
              { className: 'dpb-toolbar' },
              h('input', {
                className: 'dpb-search',
                type: 'search',
                value: query,
                placeholder: t('searchPlaceholder'),
                'aria-label': t('searchPlaceholder'),
                onChange: function (event) { setQuery(event.target.value); },
              }),
            ),
            state.plugins.length === 0
              ? h('div', { className: 'dpb-empty' }, t('noPlugins'))
              : visible.length === 0
                ? h('div', { className: 'dpb-empty' }, t('noSearchResults'))
                : h(
                    'div',
                    { className: 'dpb-list' },
                    visible.map(function (row) {
                      return renderPlugin(row, {
                        t: t,
                        lang: lang,
                        selected: draft.selected.has(row.package),
                        detail: expanded[row.package],
                        onToggle: togglePackage,
                        onDetail: toggleDetail,
                      });
                    }),
                  ),
            selectedWithApi.length === 0
              ? h('div', { className: 'dpb-muted' }, t('noSelection'))
              : null,
          ),
        ),

        // Agent tools
        h(
          'div',
          { className: 'dpb-card' },
          h(
            'div',
            { className: 'dpb-card-head' },
            h(
              'div',
              null,
              h('h3', { className: 'dpb-card-title' }, t('toolsTitle')),
              h('div', { className: 'dpb-muted' }, t('toolsCount', { n: state.tools.count })),
            ),
            h(
              'label',
              { className: 'dpb-switch' },
              h('input', {
                type: 'checkbox',
                checked: draft.exposeTools,
                onChange: function (event) {
                  var value = event.target.checked;
                  setDraft(function (current) {
                    return current === null ? current : Object.assign({}, current, { exposeTools: value });
                  });
                },
              }),
              t('toolsExpose'),
            ),
          ),
          h(
            'div',
            { className: 'dpb-card-body' },
            h('div', { className: 'dpb-muted' }, t('toolsHint')),
            draft.exposeTools ? h('div', { className: 'dpb-warnbox' }, t('toolsWarning')) : null,
          ),
        ),

        // Usage
        h(
          'div',
          { className: 'dpb-card' },
          h(
            'div',
            { className: 'dpb-card-head' },
            h('h3', { className: 'dpb-card-title' }, t('usageTitle')),
          ),
          h(
            'div',
            { className: 'dpb-card-body' },
            h('div', { className: 'dpb-muted' }, t('usageHint')),
            h('div', { className: 'dpb-muted' }, t('usagePlugins')),
            h(
              'pre',
              { className: 'dpb-pre' },
              'curl -s \\\n  -H "Authorization: Bearer <token>" \\\n  ' + state.baseUrl + '/plugins',
            ),
            h('div', { className: 'dpb-muted' }, t('usageInvoke')),
            h(
              'pre',
              { className: 'dpb-pre' },
              'curl -s -X POST \\\n  -H "Authorization: Bearer <token>" \\\n  -H "content-type: application/json" \\\n  -d ' +
                JSON.stringify(JSON.stringify(exampleBody)) +
                ' \\\n  ' +
                state.baseUrl +
                '/invoke',
            ),
            exampleEndpoint !== undefined && exampleEndpoint.requiresAgent !== null
              ? h('div', { className: 'dpb-muted' }, t('usageNote'))
              : null,
          ),
        ),

        h('div', { className: 'dpb-foot' }, dirty ? h('span', { className: 'dpb-muted' }, t('unsaved')) : null, saveButton),
      );
    }

    /** One statistic tile. */
    function stat(label, value) {
      return h('div', { className: 'dpb-stat' }, h('b', null, String(value)), h('span', null, label));
    }

    /** One labelled field row. */
    function field(label, value, action) {
      return h(
        'div',
        { className: 'dpb-field' },
        h('span', { className: 'dpb-field-label' }, label),
        h('span', { className: 'dpb-field-value' }, value, action === undefined ? null : action),
      );
    }

    /** Render one plugin row and its expanded endpoint detail. */
    function renderPlugin(row, options) {
      var t = options.t;
      var selected = options.selected;
      var canSelect = row.endpointCount > 0;
      var detail = options.detail;
      var open = detail !== undefined;
      var checkedInput = h('input', {
        type: 'checkbox',
        checked: selected,
        disabled: !canSelect && !selected,
        onChange: function () {
          options.onToggle(row.package);
        },
        'aria-label': row.title,
      });
      return h(
        'div',
        { key: row.package, className: 'dpb-plugin' + (selected ? ' selected' : '') },
        h(
          'div',
          { className: 'dpb-plugin-main' },
          checkedInput,
          h(
            'span',
            { className: 'dpb-plugin-text' },
            h(
              'span',
              { className: 'dpb-plugin-title' },
              row.title,
              row.version !== undefined ? h('span', { className: 'dpb-badge' }, 'v' + row.version) : null,
              row.phase !== null
                ? h('span', { className: phaseClass(row.phase) }, phaseText(options.lang, row.phase))
                : null,
              selected ? h('span', { className: 'dpb-badge dpb-badge-brand' }, t('enabled')) : null,
            ),
            h('span', { className: 'dpb-plugin-pkg' }, row.package),
            row.description !== undefined && row.description !== ''
              ? h('span', { className: 'dpb-plugin-desc' }, row.description)
              : null,
          ),
        ),
        h(
          'div',
          { className: 'dpb-plugin-meta' },
          canSelect
            ? h('span', { className: 'dpb-badge' }, t('endpointCount', { n: row.endpointCount }))
            : h('span', { className: 'dpb-muted' }, t('noApi')),
          row.streamCount > 0 ? h('span', { className: 'dpb-badge dpb-badge-warn' }, t('streamCount', { n: row.streamCount })) : null,
          canSelect
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dpb-btn dpb-btn-ghost',
                  onClick: function () { options.onDetail(row.package); },
                  'aria-expanded': open,
                },
                open ? t('hideDetails') : t('details'),
                ' ',
                h(Icon, { name: open ? 'minus' : 'plus' }),
              )
            : null,
        ),
        open ? renderDetail(row, detail, t, options.lang) : null,
      );
    }

    /** Render the expanded detail of one plugin. */
    function renderDetail(row, detail, t, lang) {
      if (detail.loading === true) {
        return h('div', { className: 'dpb-detail' }, h('div', { className: 'dpb-muted' }, t('loading')));
      }
      if (detail.error !== undefined) {
        return h('div', { className: 'dpb-detail' }, h('div', { className: 'dpb-error' }, detail.error));
      }
      var data = detail.detail || {};
      var entries = Array.isArray(data.entries) ? data.entries : [];
      var endpoints = Array.isArray(data.endpoints) ? data.endpoints : [];
      return h(
        'div',
        { className: 'dpb-detail' },
        entries.length > 0
          ? h(
              'div',
              { className: 'dpb-muted' },
              t('entries') +
                '：' +
                entries
                  .map(function (entry) {
                    return (entry.id || entry.moduleName) + (entry.phase === null ? '' : ' · ' + phaseText(lang, entry.phase));
                  })
                  .join(' · '),
            )
          : null,
        endpoints.length === 0
          ? h('div', { className: 'dpb-muted' }, t('noApi'))
          : endpoints.map(function (endpoint) {
              return h(
                'div',
                { key: endpoint.endpoint, className: 'dpb-endpoint' },
                h(
                  'div',
                  { className: 'dpb-endpoint-head' },
                  h('span', { className: 'dpb-endpoint-name' }, endpoint.endpoint),
                  h(
                    'span',
                    { className: endpoint.kind === 'stream' ? 'dpb-badge dpb-badge-warn' : 'dpb-badge' },
                    endpoint.kind,
                  ),
                  endpoint.requiresAgent !== null
                    ? h('span', { className: 'dpb-badge dpb-badge-brand' }, t('requiresAgent'))
                    : null,
                ),
                endpoint.description !== undefined
                  ? h('div', { className: 'dpb-endpoint-desc' }, endpoint.description)
                  : null,
                endpoint.kind === 'stream' ? h('div', { className: 'dpb-muted' }, t('streamUnsupported')) : null,
                h(
                  'div',
                  { className: 'dpb-params' },
                  h('div', { className: 'dpb-muted' }, t('parameters')),
                  endpoint.parameters.length === 0
                    ? h('div', { className: 'dpb-muted' }, t('noParameters'))
                    : endpoint.parameters.map(function (parameter) {
                        return h(
                          'div',
                          { key: parameter.wire, className: 'dpb-param' },
                          h('span', { className: 'dpb-param-name' }, parameter.wire),
                          h('span', { className: 'dpb-badge' }, schemaLabel(parameter.schema)),
                          h(
                            'span',
                            { className: parameter.required ? 'dpb-badge dpb-badge-brand' : 'dpb-badge' },
                            parameter.required ? t('required') : t('optional'),
                          ),
                          parameter.description !== undefined
                            ? h('span', { className: 'dpb-param-desc' }, parameter.description)
                            : null,
                        );
                      }),
                ),
                h(
                  'div',
                  { className: 'dpb-params' },
                  h('div', { className: 'dpb-muted' }, t('result') + ' · ' + schemaLabel(endpoint.result.schema)),
                  endpoint.result.description !== undefined
                    ? h('div', { className: 'dpb-muted' }, endpoint.result.description)
                    : null,
                ),
              );
            }),
      );
    }

    return {
      name: NS,
      // A declared service is resolved before apply(); `ctx.get('slots')` with
      // an empty inject list would stay undefined even while the slot service
      // is live, and the settings page would never register.
      inject: ['slots'],
      apply: function apply(ctx) {
        var locale = ctx.get('locale');
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(
            function () {
              return locale.register(NS, { zh: DICT.zh, en: DICT.en });
            },
            'dsh-plugins-bridge: dictionaries',
          );
          try {
            var read = function () {
              setLang(locale.getLocale().id === 'en' ? 'en' : 'zh');
            };
            read();
            ctx.effect(
              function () {
                return locale.subscribe(read);
              },
              'dsh-plugins-bridge: locale mirror',
            );
          } catch (error) {
            console.warn('[dsh-plugins-bridge] locale mirror skipped:', error);
          }
        }

        ctx.effect(
          function () {
            return ctx.slots.inject('settings.section', function () {
              return ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'plugins-bridge',
                  order: 36,
                  label: function () {
                    return translate(currentLang, 'nav');
                  },
                },
                BridgePage,
              );
            });
          },
          'dsh-plugins-bridge: settings section',
        );
      },
    };
  },
});
