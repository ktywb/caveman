#!/usr/bin/env node
// caveman — UserPromptSubmit hook to track which caveman mode is active
// Inspects user input for /caveman commands and writes mode to flag file

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { getDefaultMode, safeWriteFlag, readFlag, VALID_MODES } = require('./caveman-config');

// Modes handled by their own slash commands (/caveman-commit, etc.) — not
// selectable via /caveman <arg>.
const INDEPENDENT_MODES = new Set(['commit', 'review', 'compress']);

const WENYAN_ALIASES = new Set([
  'wenyan-full', 'wenyan', 'zh', 'zh-cn', 'chinese',
  '中文', '汉语', '漢語', '文言', '文言文', '古文'
]);
const WENYAN_LITE_ALIASES = new Set([
  'wenyan-lite', 'zh-lite', 'chinese-lite', '中文-lite', '文言-lite', '文言文-lite'
]);
const WENYAN_ULTRA_ALIASES = new Set([
  'wenyan-ultra', 'zh-ultra', 'chinese-ultra', '中文-ultra', '文言-ultra', '文言文-ultra'
]);

function normalizeModeArg(arg) {
  const raw = String(arg || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'off' || raw === 'stop' || raw === 'disable') return 'off';
  if (WENYAN_ALIASES.has(raw)) return 'wenyan';
  if (WENYAN_LITE_ALIASES.has(raw)) return 'wenyan-lite';
  if (WENYAN_ULTRA_ALIASES.has(raw)) return 'wenyan-ultra';
  if (VALID_MODES.includes(raw) && !INDEPENDENT_MODES.has(raw)) return raw;
  return null;
}

function asksForWenyanChinese(prompt) {
  return /(中文|汉语|漢語|文言文|文言|古文)/.test(prompt) &&
    /(说话|說話|回答|回复|回覆|表达|表達|思考|思维|思維|think|thinking|reason|用|使用|切换|切換|模式|mode)/i.test(prompt);
}

function asksToDeactivate(prompt) {
  return /\b(stop|disable|deactivate|turn off)\b.*\bcaveman\b/i.test(prompt) ||
    /\bcaveman\b.*\b(stop|disable|deactivate|turn off)\b/i.test(prompt) ||
    /\bnormal mode\b/i.test(prompt) ||
    /(停止|停用|关闭|關閉|退出|取消|不要|不用).*(caveman|穴居人|文言文|文言|古文)/.test(prompt) ||
    /(caveman|穴居人|文言文|文言|古文).*(停止|停用|关闭|關閉|退出|取消)/.test(prompt) ||
    /(恢复|恢復|切回|返回).*(正常|普通).*模式/.test(prompt);
}

function reinforcementLine(activeMode) {
  const base = "CAVEMAN MODE ACTIVE (" + activeMode + "). ";
  if (activeMode.startsWith('wenyan')) {
    return base +
      "Use Chinese 文言文 for visible prose, including concise reasoning/thought summaries. " +
      "Keep technical terms, code, commands, API names, and exact errors verbatim. " +
      "Code/commits/security: write normal.";
  }
  return base +
    "Drop articles/filler/pleasantries/hedging. Fragments OK. " +
    "Code/commits/security: write normal.";
}

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const flagPath = path.join(claudeDir, '.caveman-active');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = (data.prompt || '').trim().toLowerCase();

    // Natural language activation (e.g. "activate caveman", "turn on caveman mode",
    // "talk like caveman"). README tells users they can say these, but the hook
    // only matched /caveman commands — flag file and statusline stayed out of sync.
    // Also recognize brevity requests ("less tokens", "be brief/terse", "fewer
    // tokens", "shorter answers") — README promises these trigger caveman too.
    if (asksForWenyanChinese(prompt) && !asksToDeactivate(prompt)) {
      safeWriteFlag(flagPath, 'wenyan');
    } else if (/\b(activate|enable|turn on|start|talk like)\b.*\bcaveman\b/i.test(prompt) ||
        /\bcaveman\b.*\b(mode|activate|enable|turn on|start)\b/i.test(prompt) ||
        /\b(less tokens|fewer tokens|be brief|be terse|shorter answers)\b/i.test(prompt)) {
      if (!/\b(stop|disable|turn off|deactivate)\b/i.test(prompt)) {
        const mode = getDefaultMode();
        if (mode !== 'off') {
          safeWriteFlag(flagPath, mode);
        }
      }
    }

    // /caveman-stats [--share] — block the prompt and inject stats output as
    // the hook's reason. The script reads the active session log, so we pass
    // transcript_path through when Claude Code provides it.
    const statsMatch = /^\/caveman(?::caveman)?-stats(?:\s+(.*))?$/.exec(prompt);
    if (statsMatch) {
      const tailArgs = (statsMatch[1] || '').trim().split(/\s+/).filter(Boolean);
      try {
        const statsPath = path.join(__dirname, 'caveman-stats.js');
        const argv = [statsPath];
        if (data.transcript_path) argv.push('--session-file', data.transcript_path);
        if (tailArgs.includes('--share')) argv.push('--share');
        if (tailArgs.includes('--all')) argv.push('--all');
        const sinceIdx = tailArgs.indexOf('--since');
        if (sinceIdx !== -1 && tailArgs[sinceIdx + 1]) {
          argv.push('--since', tailArgs[sinceIdx + 1]);
        }
        const out = execFileSync(process.execPath, argv, { encoding: 'utf8', timeout: 5000 });
        process.stdout.write(JSON.stringify({ decision: 'block', reason: out.trim() }));
      } catch (e) {
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: 'caveman-stats: could not run stats script.\nTry manually: node hooks/caveman-stats.js'
        }));
      }
      return;
    }

    // Match /caveman commands
    if (prompt.startsWith('/caveman')) {
      const parts = prompt.split(/\s+/);
      const cmd = parts[0]; // /caveman, /caveman-commit, /caveman-review, etc.
      const arg = parts[1] || '';

      let mode = null;

      if (cmd === '/caveman-commit') {
        mode = 'commit';
      } else if (cmd === '/caveman-review') {
        mode = 'review';
      } else if (cmd === '/caveman-compress' || cmd === '/caveman:caveman-compress') {
        mode = 'compress';
      } else if (cmd === '/caveman' || cmd === '/caveman:caveman') {
        // Bare /caveman → activate at configured default
        if (!arg) {
          mode = getDefaultMode();
        } else {
          mode = normalizeModeArg(arg);
        }
        // Unknown arg → mode stays null, flag untouched (no silent overwrite)
      }

      if (mode && mode !== 'off') {
        safeWriteFlag(flagPath, mode);
      } else if (mode === 'off') {
        try { fs.unlinkSync(flagPath); } catch (e) {}
      }
    }

    // Detect deactivation — natural language and slash commands
    if (asksToDeactivate(prompt)) {
      try { fs.unlinkSync(flagPath); } catch (e) {}
    }

    // Per-turn reinforcement: emit a structured reminder when caveman is active.
    // The SessionStart hook injects the full ruleset once, but models lose it
    // when other plugins inject competing style instructions every turn.
    // This keeps caveman visible in the model's attention on every user message.
    //
    // Skip independent modes (commit, review, compress) — they have their own
    // skill behavior and the base caveman rules would conflict.
    // readFlag enforces symlink-safe read + size cap + VALID_MODES whitelist.
    // If the flag is missing, corrupted, oversized, or a symlink pointing at
    // something like ~/.ssh/id_rsa, readFlag returns null and we emit nothing
    // — never inject untrusted bytes into model context.
    const activeMode = readFlag(flagPath);
    if (activeMode && !INDEPENDENT_MODES.has(activeMode)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: reinforcementLine(activeMode)
        }
      }));
    }
  } catch (e) {
    // Silent fail
  }
});
