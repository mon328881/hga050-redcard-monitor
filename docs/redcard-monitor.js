/**
 * hga050 滚球红牌监控（同页注入）
 * 挂钩站点 get_game_list（约 3–5 秒一次）+ 备用主动轮询；红牌增量去重提醒。
 */
(function () {
  // 可重复注入：更新处理函数，不重复打补丁
  const BOOT = (window.__HGA_RC_BOOT__ = window.__HGA_RC_BOOT__ || {
    hooked: false,
    handle: null,
    lastLivePost: null,
    pollTimer: null,
  });

  if (window.__HGA_REDCARD_MONITOR__) {
    // 清掉旧 UI，后面重建
    try {
      document.querySelectorAll(".hga-rc-panel,.hga-rc-toastbox,.hga-rc-mini").forEach((el) => el.remove());
    } catch (_) {}
  }

  const state = {
    snap: new Map(),
    alerted: new Set(),
    history: [],
    matchCount: 0,
    lastAt: null,
    muted: false,
    collapsed: false,
    audioCtx: null,
    lastSource: "",
    alarming: false,
    alarmTimer: null,
    monitoring: true,
    vibrateOn: true,
    volume: 10, // 1–10，10 为网页音频上限（仍受系统音量限制）
  };

  function pick(block, name) {
    const m = block.match(new RegExp("<" + name + "[^>]*>([^<]*)</" + name + ">", "i"));
    return m ? m[1] : "";
  }

  function parseGames(body) {
    if (!body || typeof body !== "string" || body.indexOf("<GID>") === -1) return [];
    const out = [];
    const re = /<game\b[^>]*>([\s\S]*?)<\/game>/gi;
    let m;
    while ((m = re.exec(body))) {
      const g = m[1];
      const gid = pick(g, "GID");
      if (!gid) continue;
      out.push({
        gid,
        ecid: pick(g, "ECID"),
        lid: pick(g, "LID"),
        league: pick(g, "LEAGUE"),
        teamH: pick(g, "TEAM_H"),
        teamC: pick(g, "TEAM_C"),
        scoreH: pick(g, "SCORE_H") || "0",
        scoreC: pick(g, "SCORE_C") || "0",
        redH: Number(pick(g, "REDCARD_H") || 0),
        redC: Number(pick(g, "REDCARD_C") || 0),
        time: (pick(g, "RETIMESET") || pick(g, "DATETIME") || "").replace("^", " "),
      });
    }
    const seen = new Set();
    return out.filter((x) => (seen.has(x.gid) ? false : (seen.add(x.gid), true)));
  }

  function ensureAudio() {
    if (!state.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      state.audioCtx = new AC();
    }
    if (state.audioCtx.state === "suspended") state.audioCtx.resume();
    return state.audioCtx;
  }

  function buzz(pattern) {
    if (!state.vibrateOn) return;
    try {
      if (navigator.vibrate) navigator.vibrate(pattern || 40);
    } catch (_) {}
  }

  function volumeGain() {
    const lv = Math.max(1, Math.min(10, Number(state.volume) || 10));
    // 网页音频 Gain 最大约 1.0；超过会削波失真，听感不再明显变大
    return lv / 10;
  }

  function playDiBurst() {
    if (state.muted) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const peak = Math.max(0.08, volumeGain());
    // 急促滴-滴-滴：方波 + 倍频，更容易穿透
    for (let i = 0; i < 3; i++) {
      const t0 = now + i * 0.1;
      [1450, 2900].forEach(function (freq, k) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "square";
        o.frequency.value = freq;
        const amp = k === 0 ? peak : peak * 0.45;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(amp, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.055);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t0);
        o.stop(t0 + 0.06);
      });
    }
    buzz([30, 30, 30, 30, 30, 30, 30]);
  }

  function stopAlarm() {
    state.alarming = false;
    if (state.alarmTimer) {
      clearInterval(state.alarmTimer);
      state.alarmTimer = null;
    }
    buzz(0);
    if (typeof miniBtn !== "undefined" && miniBtn) miniBtn.classList.remove("hga-rc-mini-pulse");
  }

  function startAlarm() {
    if (state.muted) return;
    stopAlarm();
    state.alarming = true;
    playDiBurst();
    state.alarmTimer = setInterval(function () {
      if (!state.alarming || state.muted) {
        stopAlarm();
        return;
      }
      playDiBurst();
      if (state.collapsed && miniBtn) {
        miniBtn.classList.add("hga-rc-mini-pulse");
      }
    }, 480);
  }

  // 兼容旧调用：开声音预览只响一串，不循环
  function beep() {
    playDiBurst();
  }

  function toast(msg, meta) {
    const el = document.createElement("div");
    el.className = "hga-rc-toast" + (meta && (meta.teamH || meta.ecid) ? " hga-rc-toast-click" : "");
    el.innerHTML =
      '<div class="hga-rc-toast-msg">' +
      escapeHtml(msg) +
      "</div>" +
      (meta && (meta.teamH || meta.ecid)
        ? '<div class="hga-rc-toast-tip">点击定位后停止滴滴声</div>'
        : "");
    if (meta && (meta.teamH || meta.ecid)) {
      el.addEventListener("click", function () {
        locateMatch(meta);
      });
    }
    ui.toastBox.appendChild(el);
    setTimeout(() => el.remove(), 12000);
  }

  function clearLocateHighlight() {
    document.querySelectorAll(".hga-rc-locate-hit").forEach(function (el) {
      el.classList.remove("hga-rc-locate-hit");
    });
  }

  function teamAliases(name) {
    const n = String(name || "").trim();
    if (!n) return [];
    const set = [n];
    // VPS华沙 -> 华沙；去掉前导英文/数字
    const cn = n.replace(/^[A-Za-z0-9\s\.\-]+/, "").trim();
    if (cn && cn !== n) set.push(cn);
    // 去掉括号内容
    const noParen = n.replace(/[（(].*?[）)]/g, "").trim();
    if (noParen && set.indexOf(noParen) === -1) set.push(noParen);
    return set;
  }

  function textHasTeam(text, name) {
    if (!name) return true;
    const aliases = teamAliases(name);
    for (let i = 0; i < aliases.length; i++) {
      if (text.indexOf(aliases[i]) !== -1) return true;
    }
    return false;
  }

  function findMatchElement(meta) {
    if (!meta) return null;
    const roots = [document];
    document.querySelectorAll("iframe").forEach(function (iframe) {
      try {
        if (iframe.contentDocument) roots.push(iframe.contentDocument);
      } catch (_) {}
    });

    for (let r = 0; r < roots.length; r++) {
      const doc = roots[r];
      if (meta.ecid) {
        const byId =
          doc.getElementById("game_" + meta.ecid) ||
          doc.querySelector("#mainShow_" + meta.ecid);
        if (byId) return byId;
      }
    }

    const teamH = meta.teamH || "";
    const teamC = meta.teamC || "";
    const aliasesH = teamAliases(teamH);

    for (let r = 0; r < roots.length; r++) {
      const doc = roots[r];
      const homes = doc.querySelectorAll(".box_team.teamH, .text_team, .team_name");
      for (let i = 0; i < homes.length; i++) {
        const el = homes[i];
        const t = (el.textContent || "").trim();
        let hit = false;
        for (let a = 0; a < aliasesH.length; a++) {
          if (t === aliasesH[a] || t.indexOf(aliasesH[a]) !== -1) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;
        let p = el;
        for (let k = 0; k < 10 && p; k++) {
          const cls = (p.className || "").toString();
          if ((p.id && /^game_/.test(p.id)) || cls.indexOf("box_lebet") !== -1) {
            if (!teamC || textHasTeam(p.textContent || "", teamC)) return p;
          }
          p = p.parentElement;
        }
        return el.closest(".box_lebet") || el;
      }
    }
    return null;
  }

  function getListScroller() {
    return (
      document.getElementById("body_show") ||
      document.querySelector(".box_l") ||
      document.querySelector(".content_sport") ||
      document.scrollingElement
    );
  }

  function expandLeague(meta) {
    const clicked = [];
    if (meta.lid) {
      const leg = document.getElementById("LEG_" + meta.lid);
      if (leg) {
        leg.click();
        clicked.push(leg.id);
      }
    }
    const league = meta.league || "";
    if (league) {
      const nodes = document.querySelectorAll('[id^="LEG_"], .btn_title_le');
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const t = (el.textContent || "").trim();
        if (t === league || t.indexOf(league) !== -1 || league.indexOf(t) !== -1) {
          el.click();
          clicked.push(el.id || t);
        }
      }
    }
    // 展开所有折叠联赛，提高找得到的概率
    document.querySelectorAll(".btn_title_le.off").forEach(function (el) {
      try {
        el.click();
      } catch (_) {}
    });
    return clicked;
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  async function searchByScrolling(meta) {
    let target = findMatchElement(meta);
    if (target) return target;
    const scroller = getListScroller();
    if (!scroller) return null;
    const step = Math.max(280, Math.floor((scroller.clientHeight || 600) * 0.75));
    const max = Math.max(scroller.scrollHeight || 0, 3000);
    scroller.scrollTop = 0;
    await sleep(80);
    target = findMatchElement(meta);
    if (target) return target;
    for (let y = step; y <= max + step; y += step) {
      scroller.scrollTop = y;
      await sleep(70);
      target = findMatchElement(meta);
      if (target) return target;
      // 虚拟列表可能动态增减高度
      if (y > scroller.scrollHeight + 200) break;
    }
    return findMatchElement(meta);
  }

  function highlightAndShow(target) {
    clearLocateHighlight();
    target.classList.add("hga-rc-locate-hit");
    try {
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    } catch (_) {
      const scroller = getListScroller();
      if (scroller) {
        const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 120;
        scroller.scrollTop = top;
      }
    }
    setTimeout(function () {
      collapse();
    }, 280);
    setTimeout(function () {
      clearLocateHighlight();
    }, 5000);
  }

  async function locateMatch(meta) {
    // 用户点击提醒定位：立刻停报警音
    stopAlarm();
    if (!meta || (meta.test && !meta.testLocate)) {
      toast("测试提醒无法定位真实赛事");
      return false;
    }
    expand();
    toast("正在定位： " + (meta.teamH || "") + " vs " + (meta.teamC || ""));
    try {
      expandLeague(meta);
      await sleep(350);
      let target = await searchByScrolling(meta);
      if (!target) {
        // 再展开一次后重试
        expandLeague(meta);
        await sleep(400);
        target = await searchByScrolling(meta);
      }
      if (!target) {
        toast(
          "列表里暂时看不到该场（可能已折叠/滑出/即将完场）：" +
            (meta.league || "") +
            " " +
            (meta.teamH || "") +
            " vs " +
            (meta.teamC || "")
        );
        return false;
      }
      highlightAndShow(target);
      return true;
    } catch (e) {
      toast("定位失败：" + e);
      return false;
    }
  }

  function desktopNotify(msg) {
    try {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") {
        new Notification("滚球红牌提醒", { body: msg, tag: "hga-redcard-" + Date.now() });
      }
    } catch (_) {}
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pushHistory(item) {
    state.history.unshift(item);
    if (state.history.length > 80) state.history.length = 80;
    renderHistory();
  }

  function onAlert(msg, meta, dedupeKey) {
    if (!state.monitoring) return false;
    if (dedupeKey) {
      if (state.alerted.has(dedupeKey)) return false;
      state.alerted.add(dedupeKey);
    }
    pushHistory({ msg, at: new Date(), meta: meta || null, key: dedupeKey || "" });
    toast(msg, meta);
    desktopNotify(msg);
    // 可定位的红牌：滴滴滴循环，直到点击定位；纯测试只响一串
    const needLoop = meta && (meta.teamH || meta.ecid) && !meta.test;
    if (needLoop || (meta && meta.testLocate)) {
      startAlarm();
    } else {
      playDiBurst();
    }
    if (state.collapsed) {
      miniBtn.classList.add("hga-rc-mini-pulse");
    } else {
      flashPanel();
    }
    renderStatus();
    return true;
  }

  function applyMatches(matches, source) {
    state.matchCount = matches.length;
    state.lastAt = new Date();
    if (!state.monitoring) {
      state.lastSource = "paused";
      for (const m of matches) {
        for (let n = 1; n <= m.redH; n++) state.alerted.add(m.gid + ":H:" + n);
        for (let n = 1; n <= m.redC; n++) state.alerted.add(m.gid + ":C:" + n);
        state.snap.set(m.gid, { h: m.redH, c: m.redC });
      }
      renderStatus();
      return;
    }
    state.lastSource = source || "api";
    for (const m of matches) {
      const prev = state.snap.get(m.gid) || { h: 0, c: 0 };
      const firstSee = !state.snap.has(m.gid);
      if (!firstSee) {
        if (m.redH > prev.h) {
          for (let n = prev.h + 1; n <= m.redH; n++) {
            onAlert(
              "红牌！主队 " +
                m.teamH +
                "（第" +
                n +
                "张）｜" +
                m.teamH +
                " " +
                m.scoreH +
                "-" +
                m.scoreC +
                " " +
                m.teamC +
                "｜" +
                m.league,
              Object.assign({}, m, { side: "H", n }),
              m.gid + ":H:" + n
            );
          }
        }
        if (m.redC > prev.c) {
          for (let n = prev.c + 1; n <= m.redC; n++) {
            onAlert(
              "红牌！客队 " +
                m.teamC +
                "（第" +
                n +
                "张）｜" +
                m.teamH +
                " " +
                m.scoreH +
                "-" +
                m.scoreC +
                " " +
                m.teamC +
                "｜" +
                m.league,
              Object.assign({}, m, { side: "C", n }),
              m.gid + ":C:" + n
            );
          }
        }
      } else {
        for (let n = 1; n <= m.redH; n++) state.alerted.add(m.gid + ":H:" + n);
        for (let n = 1; n <= m.redC; n++) state.alerted.add(m.gid + ":C:" + n);
      }
      state.snap.set(m.gid, { h: m.redH, c: m.redC });
    }
    renderStatus();
  }

  function maybeHandleBody(body, postData, source) {
    if (!body || typeof body !== "string") return;
    if (body.indexOf("REDCARD_") === -1 && body.indexOf("<GID>") === -1) return;
    const post = postData || "";
    if (/p=get_game_list/i.test(post) && /showtype=live|rtype=rb/i.test(post)) {
      BOOT.lastLivePost = post;
    }
    const looksGameList =
      /p=get_game_list/i.test(post) ||
      (/showtype=live|rtype=rb/i.test(post) && /<GID>/i.test(body)) ||
      (/<REDCARD_H>/i.test(body) && /<game\b/i.test(body));
    if (!looksGameList) return;
    if (!/<game\b/i.test(body)) return;
    const matches = parseGames(body);
    if (matches.length) {
      window.__HGA_RC_LAST_MATCHES__ = matches;
      applyMatches(matches, source || "hook");
    }
  }

  // 全局可替换处理函数，保证重注入后旧钩子也能走到新逻辑
  BOOT.handle = function (body, post, source) {
    try {
      maybeHandleBody(body, post, source);
    } catch (_) {}
  };

  function installHooks(win) {
    if (!win) return;
    try {
      const XHR = win.XMLHttpRequest;
      // 旧版只打了 __hgaRcXhrHooked，handler 已失效；用 __hgaRcXhrBooted 再包一层
      if (XHR && !win.__hgaRcXhrBooted) {
        win.__hgaRcXhrBooted = true;
        win.__hgaRcXhrHooked = true;
        const open = XHR.prototype.open;
        const send = XHR.prototype.send;
        XHR.prototype.open = function (method, url) {
          this.__hgaUrl = url;
          return open.apply(this, arguments);
        };
        XHR.prototype.send = function (body) {
          this.__hgaPost = typeof body === "string" ? body : "";
          this.addEventListener("load", function () {
            try {
              const boot =
                (window.top && window.top.__HGA_RC_BOOT__) || window.__HGA_RC_BOOT__;
              if (boot && typeof boot.handle === "function") {
                boot.handle(this.responseText, this.__hgaPost || "", "xhr");
              }
            } catch (_) {}
          });
          return send.apply(this, arguments);
        };
      }
      if (win.fetch && !win.__hgaRcFetchBooted) {
        win.__hgaRcFetchBooted = true;
        win.__hgaRcFetchHooked = true;
        const raw = win.fetch.bind(win);
        win.fetch = function (input, init) {
          const post = (init && typeof init.body === "string" && init.body) || "";
          return raw(input, init).then(function (res) {
            try {
              const clone = res.clone();
              clone.text().then(function (text) {
                try {
                  const boot =
                    (window.top && window.top.__HGA_RC_BOOT__) || window.__HGA_RC_BOOT__;
                  if (boot && typeof boot.handle === "function") {
                    boot.handle(text, post, "fetch");
                  }
                } catch (_) {}
              });
            } catch (_) {}
            return res;
          });
        };
      }
    } catch (_) {}
  }

  function hookAllFrames() {
    installHooks(window);
    try {
      installHooks(window.top);
    } catch (_) {}
    const frames = window.frames;
    for (let i = 0; i < frames.length; i++) {
      try {
        installHooks(frames[i]);
      } catch (_) {}
    }
    document.querySelectorAll("iframe").forEach((iframe) => {
      try {
        if (iframe.contentWindow) installHooks(iframe.contentWindow);
      } catch (_) {}
    });
  }

  async function activePoll() {
    const post = BOOT.lastLivePost;
    if (!post) return;
    try {
      const verMatch = post.match(/ver=([^&]+)/);
      const ver = verMatch ? verMatch[1] : "1";
      // 刷新 ts，避免缓存
      let body = post.replace(/(&ts=)\d+/g, "$1" + Date.now());
      if (!/&ts=/.test(body)) body += "&ts=" + Date.now();
      const res = await fetch("/transform.php?ver=" + encodeURIComponent(ver), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        credentials: "include",
      });
      const text = await res.text();
      BOOT.handle(text, body, "poll");
    } catch (_) {}
  }

  function startBackupPoll() {
    if (BOOT.pollTimer) clearInterval(BOOT.pollTimer);
    BOOT.pollTimer = setInterval(activePoll, 4000);
  }

  // UI
  const style = document.createElement("style");
  style.textContent = `
  .hga-rc-panel{all:initial;position:fixed;z-index:2147483646;right:10px;bottom:72px;width:min(92vw,360px);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    color:#f4f7fb;background:rgba(16,20,26,.96);border:1px solid rgba(255,255,255,.12);
    border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);backdrop-filter:blur(10px);overflow:hidden}
  .hga-rc-panel.hga-rc-hidden{display:none!important}
  .hga-rc-panel *{box-sizing:border-box;font-family:inherit}
  .hga-rc-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;
    background:linear-gradient(90deg,rgba(226,61,44,.35),rgba(226,61,44,.08));border-bottom:1px solid rgba(255,255,255,.08)}
  .hga-rc-hd b{font-size:14px}
  .hga-rc-hd .sub{display:block;font-size:11px;opacity:.75;margin-top:2px}
  .hga-rc-acts{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;max-width:58%}
  .hga-rc-acts button{border:0;border-radius:8px;padding:6px 8px;font-size:12px;background:#2a3340;color:#fff;cursor:pointer}
  .hga-rc-acts button.primary{background:#e23d2c}
  .hga-rc-acts button.off{background:#3a4452;color:#9aa6b5}
  .hga-rc-acts button.on{background:#1f7a4c}
  .hga-rc-body{max-height:38vh;overflow:auto;padding:8px 10px 12px}
  .hga-rc-status{font-size:12px;opacity:.85;margin-bottom:6px;line-height:1.4}
  .hga-rc-empty{padding:18px 8px;text-align:center;color:rgba(244,247,251,.55);font-size:13px}
  .hga-rc-swipe{position:relative;margin-top:8px;border-radius:12px;overflow:hidden;background:#1a222d}
  .hga-rc-swipe-actions{position:absolute;top:0;right:-76px;bottom:0;width:76px;display:flex;z-index:0;transition:right .18s ease;pointer-events:none}
  .hga-rc-swipe.open .hga-rc-swipe-actions{right:0;pointer-events:auto}
  .hga-rc-del{border:0;width:76px;height:100%;padding:0;margin:0;background:linear-gradient(180deg,#ff4d3d,#c62828);color:#fff;font-size:13px;font-weight:750;cursor:pointer;letter-spacing:.06em}
  .hga-rc-item{position:relative;z-index:1;width:100%;padding:10px 12px;border-radius:12px;background:#243040;border:1px solid rgba(255,255,255,.1);font-size:12px;line-height:1.45;cursor:pointer;
    transition:transform .18s ease;touch-action:pan-y;user-select:none;-webkit-user-select:none;will-change:transform;-webkit-transform:translateX(0);transform:translateX(0)}
  .hga-rc-item .t{font-weight:700;font-size:13px;color:#ffe8e4}
  .hga-rc-item .m{opacity:.75;margin-top:4px;color:#c5d0dc}
  .hga-rc-item .go{opacity:.9;margin-top:6px;font-size:11px;color:#ffb4ab}
  .hga-rc-swipe.open .hga-rc-item{-webkit-transform:translateX(-76px);transform:translateX(-76px);border-color:rgba(255,255,255,.06)}
  .hga-rc-toastbox{position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);
    width:min(92vw,420px);display:flex;flex-direction:column;gap:8px;pointer-events:none}
  .hga-rc-toast{pointer-events:none;background:#3a1410;color:#ffe8e4;border:1px solid rgba(255,120,100,.55);
    border-radius:12px;padding:12px 14px;font-size:14px;font-weight:650;box-shadow:0 10px 30px rgba(0,0,0,.35);
    animation:hgaRcIn .25s ease}
  .hga-rc-toast-click{pointer-events:auto;cursor:pointer}
  .hga-rc-toast-tip{margin-top:6px;font-size:11px;font-weight:500;opacity:.85;color:#ffb4ab}
  .hga-rc-locate-hit{outline:3px solid #e23d2c !important; box-shadow:0 0 0 4px rgba(226,61,44,.35),0 8px 24px rgba(0,0,0,.35) !important;
    border-radius:10px; animation:hgaRcLocate 1s ease 3; scroll-margin:90px}
  @keyframes hgaRcLocate{0%,100%{outline-color:#e23d2c}50%{outline-color:#ffd27a}}
  @keyframes hgaRcIn{from{transform:translateY(-10px);opacity:0}to{transform:none;opacity:1}}
  .hga-rc-flash{animation:hgaRcFlash .8s ease}
  @keyframes hgaRcFlash{0%,100%{box-shadow:0 12px 40px rgba(0,0,0,.45)}50%{box-shadow:0 0 0 3px rgba(226,61,44,.8),0 12px 40px rgba(0,0,0,.45)}}
  .hga-rc-mini{all:initial;position:fixed;z-index:2147483646;right:0;top:42%;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    background:#e23d2c;color:#fff;border:0;border-radius:10px 0 0 10px;
    padding:12px 8px;font-size:14px;font-weight:750;letter-spacing:.04em;box-shadow:0 8px 24px rgba(0,0,0,.35);
    cursor:pointer;display:none}
  .hga-rc-mini.hga-rc-mini-show{display:block}
  .hga-rc-mini-pulse{animation:hgaRcMiniPulse 1.2s ease 2}
  @keyframes hgaRcMiniPulse{0%,100%{transform:translateX(0)}50%{transform:translateX(-4px);box-shadow:0 0 0 3px rgba(226,61,44,.55),0 8px 24px rgba(0,0,0,.35)}}
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement("div");
  panel.className = "hga-rc-panel";
  panel.innerHTML =
    '<div class="hga-rc-hd"><div><b>红牌监控</b><span class="sub">左滑删历史 · 点提醒定位停声</span></div>' +
    '<div class="hga-rc-acts">' +
    '<button type="button" data-act="monitor" class="on">监控开</button>' +
    '<button type="button" data-act="vibrate" class="on">震动开</button>' +
    '<button type="button" data-act="sound" class="primary">开声音</button>' +
    '<button type="button" data-act="vol-">音量-</button>' +
    '<button type="button" data-act="vol+">音量+</button>' +
    '<button type="button" data-act="mute">静音</button>' +
    '<button type="button" data-act="test">测试</button>' +
    '<button type="button" data-act="collapse">收起</button>' +
    "</div></div>" +
    '<div class="hga-rc-body"><div class="hga-rc-status" id="hgaRcStatus">等待滚球数据…保持在滚球页</div>' +
    '<div id="hgaRcHistory"><div class="hga-rc-empty">暂无红牌记录</div></div></div>';
  document.documentElement.appendChild(panel);

  const miniBtn = document.createElement("button");
  miniBtn.type = "button";
  miniBtn.className = "hga-rc-mini";
  miniBtn.textContent = "监控";
  document.documentElement.appendChild(miniBtn);

  const toastBox = document.createElement("div");
  toastBox.className = "hga-rc-toastbox";
  document.documentElement.appendChild(toastBox);

  const ui = {
    panel,
    toastBox,
    status: panel.querySelector("#hgaRcStatus"),
    history: panel.querySelector("#hgaRcHistory"),
  };

  function flashPanel() {
    panel.classList.remove("hga-rc-flash");
    void panel.offsetWidth;
    panel.classList.add("hga-rc-flash");
  }

  function renderStatus() {
    const t = state.lastAt
      ? state.lastAt.toLocaleTimeString("zh-CN", { hour12: false })
      : "—";
    const bits = [];
    bits.push(state.monitoring ? "监控中" : "已暂停");
    if (state.matchCount) bits.push(state.matchCount + " 场");
    bits.push("最近 " + t);
    bits.push("历史 " + state.history.length);
    if (state.vibrateOn) bits.push("震动");
    bits.push("音量 " + state.volume + "/10");
    if (state.muted) bits.push("已静音");
    if (state.alarming) bits.push("报警中");
    ui.status.textContent = bits.join(" · ");
    const monBtn = panel.querySelector('[data-act="monitor"]');
    if (monBtn) {
      monBtn.textContent = state.monitoring ? "监控开" : "监控关";
      monBtn.className = state.monitoring ? "on" : "off";
    }
    const vibBtn = panel.querySelector('[data-act="vibrate"]');
    if (vibBtn) {
      vibBtn.textContent = state.vibrateOn ? "震动开" : "震动关";
      vibBtn.className = state.vibrateOn ? "on" : "off";
    }
  }

  function closeAllSwipes(except) {
    ui.history.querySelectorAll(".hga-rc-swipe.open").forEach(function (el) {
      if (el !== except) {
        el.classList.remove("open");
        const it = el.querySelector(".hga-rc-item");
        const act = el.querySelector(".hga-rc-swipe-actions");
        if (it) {
          it.style.webkitTransform = "translateX(0)";
          it.style.transform = "translateX(0)";
        }
        if (act) act.style.right = "-76px";
      }
    });
  }

  function deleteHistory(idx) {
    if (idx < 0 || idx >= state.history.length) return;
    buzz([20, 40, 35]);
    state.history.splice(idx, 1);
    renderHistory();
    renderStatus();
  }

  function bindHistorySwipe() {
    const rows = ui.history.querySelectorAll(".hga-rc-swipe");
    rows.forEach(function (row) {
      const item = row.querySelector(".hga-rc-item");
      if (!item) return;
      let startX = 0;
      let startY = 0;
      let dx = 0;
      let locking = "";
      let moved = false;

      function onStart(x, y) {
        startX = x;
        startY = y;
        dx = 0;
        locking = "";
        moved = false;
      }
      function onMove(x, y, ev) {
        const adx = x - startX;
        const ady = y - startY;
        if (!locking) {
          if (Math.abs(adx) < 6 && Math.abs(ady) < 6) return;
          locking = Math.abs(adx) > Math.abs(ady) ? "x" : "y";
        }
        if (locking !== "x") return;
        if (ev && ev.cancelable) ev.preventDefault();
        moved = true;
        dx = adx;
        const open = row.classList.contains("open");
        let tx = open ? -76 + dx : dx;
        if (tx > 0) tx = 0;
        if (tx < -76) tx = -76;
        item.style.transition = "none";
        item.style.webkitTransform = "translateX(" + tx + "px)";
        item.style.transform = "translateX(" + tx + "px)";
        const actions = row.querySelector(".hga-rc-swipe-actions");
        if (actions) actions.style.right = -76 - tx + "px";
      }
      function onEnd() {
        item.style.transition = "";
        const actions = row.querySelector(".hga-rc-swipe-actions");
        if (actions) actions.style.right = "";
        if (!moved || locking !== "x") {
          item.style.webkitTransform = "";
          item.style.transform = "";
          return;
        }
        const open = row.classList.contains("open");
        const shouldOpen = open ? dx < 24 : dx < -40;
        closeAllSwipes(row);
        if (shouldOpen) {
          row.classList.add("open");
          item.style.webkitTransform = "translateX(-76px)";
          item.style.transform = "translateX(-76px)";
          if (actions) actions.style.right = "0px";
          buzz(18);
        } else {
          row.classList.remove("open");
          item.style.webkitTransform = "translateX(0)";
          item.style.transform = "translateX(0)";
          if (actions) actions.style.right = "-76px";
        }
        row.__hgaSkipClick = moved;
      }

      item.addEventListener(
        "touchstart",
        function (e) {
          const t = e.changedTouches[0];
          onStart(t.clientX, t.clientY);
        },
        { passive: true }
      );
      item.addEventListener(
        "touchmove",
        function (e) {
          const t = e.changedTouches[0];
          onMove(t.clientX, t.clientY, e);
        },
        { passive: false }
      );
      item.addEventListener(
        "touchend",
        function () {
          onEnd();
        },
        { passive: true }
      );

      // 鼠标拖拽（方便桌面调试）
      let down = false;
      item.addEventListener("mousedown", function (e) {
        down = true;
        onStart(e.clientX, e.clientY);
      });
      window.addEventListener("mousemove", function (e) {
        if (!down) return;
        onMove(e.clientX, e.clientY, e);
      });
      window.addEventListener("mouseup", function () {
        if (!down) return;
        down = false;
        onEnd();
      });
    });
  }

  function renderHistory() {
    if (!state.history.length) {
      ui.history.innerHTML = '<div class="hga-rc-empty">暂无红牌记录</div>';
      return;
    }
    ui.history.innerHTML = state.history
      .slice(0, 30)
      .map(function (a, idx) {
        const tm = a.at.toLocaleTimeString("zh-CN", { hour12: false });
        const canGo = a.meta && (a.meta.teamH || a.meta.ecid) && !a.meta.test;
        return (
          '<div class="hga-rc-swipe" data-swipe="' +
          idx +
          '">' +
          '<div class="hga-rc-swipe-actions" style="right:-76px"><button type="button" class="hga-rc-del" data-del="' +
          idx +
          '">删除</button></div>' +
          '<div class="hga-rc-item" data-hist="' +
          idx +
          '"><div class="t">' +
          escapeHtml(a.msg) +
          '</div><div class="m">' +
          tm +
          " · 左滑删除</div>" +
          (canGo ? '<div class="go">点击定位 · 定位后停声</div>' : "") +
          "</div></div>"
        );
      })
      .join("");
    bindHistorySwipe();
  }

  function collapse() {
    state.collapsed = true;
    panel.classList.add("hga-rc-hidden");
    miniBtn.classList.add("hga-rc-mini-show");
  }

  function expand() {
    state.collapsed = false;
    panel.classList.remove("hga-rc-hidden");
    miniBtn.classList.remove("hga-rc-mini-show");
    miniBtn.classList.remove("hga-rc-mini-pulse");
  }

  miniBtn.addEventListener("click", function () {
    expand();
    ensureAudio();
  });

  panel.addEventListener("click", function (e) {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      deleteHistory(Number(del.getAttribute("data-del")));
      return;
    }
    const hist = e.target.closest("[data-hist]");
    if (hist) {
      const row = hist.closest(".hga-rc-swipe");
      if (row && row.__hgaSkipClick) {
        row.__hgaSkipClick = false;
        return;
      }
      if (row && row.classList.contains("open")) {
        row.classList.remove("open");
        hist.style.webkitTransform = "translateX(0)";
        hist.style.transform = "translateX(0)";
        const act = row.querySelector(".hga-rc-swipe-actions");
        if (act) act.style.right = "-76px";
        return;
      }
      closeAllSwipes();
      const idx = Number(hist.getAttribute("data-hist"));
      const item = state.history[idx];
      if (item && item.meta) locateMatch(item.meta);
      return;
    }
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act === "sound") {
      ensureAudio();
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
      beep();
      toast("声音已开启");
    } else if (act === "monitor") {
      state.monitoring = !state.monitoring;
      if (!state.monitoring) stopAlarm();
      buzz(state.monitoring ? [20, 30, 40] : [40]);
      toast(state.monitoring ? "监控已开启" : "监控已暂停（不再提醒）");
      renderStatus();
    } else if (act === "vibrate") {
      state.vibrateOn = !state.vibrateOn;
      if (state.vibrateOn) buzz([25, 30, 25]);
      toast(state.vibrateOn ? "震动已开启" : "震动已关闭");
      renderStatus();
    } else if (act === "vol-") {
      state.volume = Math.max(1, state.volume - 1);
      state.muted = false;
      ensureAudio();
      playDiBurst();
      toast("音量 " + state.volume + "/10" + (state.volume <= 1 ? "（最低）" : ""));
      renderStatus();
    } else if (act === "vol+") {
      state.volume = Math.min(10, state.volume + 1);
      state.muted = false;
      ensureAudio();
      playDiBurst();
      toast(
        "音量 " +
          state.volume +
          "/10" +
          (state.volume >= 10 ? "（网页上限；再大只能调手机系统音量）" : "")
      );
      renderStatus();
    } else if (act === "mute") {
      state.muted = !state.muted;
      btn.textContent = state.muted ? "取消静音" : "静音";
      if (state.muted) stopAlarm();
      renderStatus();
    } else if (act === "test") {
      ensureAudio();
      const any = window.__HGA_RC_LAST_MATCHES__ && window.__HGA_RC_LAST_MATCHES__[0];
      if (any) {
        onAlert(
          "测试定位：" + any.teamH + " vs " + any.teamC + "（点击停止滴滴声并定位）",
          Object.assign({}, any, { testLocate: true }),
          null
        );
      } else {
        onAlert("测试红牌提醒：弹窗 + 声音 + 震动", { test: true }, null);
      }
    } else if (act === "collapse") {
      collapse();
    }
  });

  hookAllFrames();
  setInterval(hookAllFrames, 3000);
  startBackupPoll();

  window.__HGA_REDCARD_MONITOR__ = {
    panel,
    miniBtn,
    toast,
    state,
    applyMatches,
    expand,
    collapse,
    locateMatch,
    pollNow: activePoll,
    stopAlarm,
    startAlarm,
  };

  toast("红牌监控已修复启动：跟站点约3~5秒同步");
})();
