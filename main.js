const { app, BrowserWindow, globalShortcut, Notification, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('ffmpeg-static');
const cleanup = require('./cleanup');
const settingsManager = require('./settings_manager');
const activityLogger = require('./activity_logger');
const secretManager = require('./secret_manager');

// Help functionality: Load .env from both local and original project
function loadEnv(targetPath) {
  if (fs.existsSync(targetPath)) {
    try {
      const envRaw = fs.readFileSync(targetPath, 'utf8');
      envRaw.split(/\r?\n/).forEach(line => {
        const m = line.match(/^([^=]+)=(.*)$/);
        if (m) {
          const k = m[1].trim();
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (!process.env[k]) process.env[k] = v;
        }
      });
      console.log('[LeelaV1] Loaded env from', targetPath);
    } catch (e) {
      console.warn('[LeelaV1] Failed to read .env at', targetPath, e);
    }
  }
}

loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(__dirname, '..', 'voice-writer-ai', '.env'));
loadEnv(path.join('C:', 'Users', 'admin', 'Documents', 'SpeechToTextAI', 'voice-writer-ai', '.env'));

// Basic crash handlers to keep behavior similar to original project
process.on('uncaughtException', (err) => {
  console.error('[LeelaV1 MAIN] Uncaught Exception:', err && err.message ? err.message : err);
  setTimeout(() => process.exit(1), 300);
});
process.on('unhandledRejection', (reason) => {
  console.error('[LeelaV1 MAIN] Unhandled Rejection:', reason);
  setTimeout(() => process.exit(1), 300);
});

let isProcessingHotkey = false;
let statusWindow;
let dashboardWindow;

const AppStates = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  SUCCESS_PASTE: 'SUCCESS_PASTE',
  SUCCESS_POLISH: 'SUCCESS_POLISH',
  ERROR: 'ERROR'
};

let currentStateStatus = AppStates.IDLE;

// createWindow() removed - functionality merged into Dashboard

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) return;

  statusWindow = new BrowserWindow({
    width: 160,
    height: 60,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  statusWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  // Position at Top-Center
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;
  // Centered horizontally, 5px from top
  statusWindow.setPosition(Math.floor((width - 160) / 2), 5);
}

function updateState(state) {
  // Check if overlay is enabled in settings
  const settings = settingsManager.getSettings();
  if (!settings.overlayEnabled && state !== AppStates.IDLE) return;

  if (currentStateStatus !== state) {
    console.log(`[STATE] Transition: ${currentStateStatus} -> ${state}`);
    currentStateStatus = state;
  }

  if (!statusWindow || statusWindow.isDestroyed()) createStatusWindow();

  if (state === AppStates.IDLE) {
    statusWindow.webContents.send('hide-status');
    setTimeout(() => { if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide(); }, 400);
  } else {
    // Ensure it stays at Top-Center (fixed)
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width } = primaryDisplay.workAreaSize;
    statusWindow.setPosition(Math.floor((width - 240) / 2), 5);

    statusWindow.show();
    statusWindow.webContents.send('update-status', state);

    // Auto-hide for terminal states
    if (state === AppStates.SUCCESS_PASTE || state === AppStates.SUCCESS_POLISH || state === AppStates.ERROR) {
      setTimeout(() => updateState(AppStates.IDLE), 1500);
    }
  }
}

let tray = null;

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const { Menu, Tray } = require('electron');
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => createDashboardWindow() },
    {
      label: 'Settings', click: () => {
        createDashboardWindow();
        // Potentially send IPC to switch to settings tab here if needed
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Leela V1', click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Leela V1 - AI Assistant');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    createDashboardWindow();
  });
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Leela V1 Dashboard',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  dashboardWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));

  // Instead of closing, hide the dashboard
  dashboardWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      dashboardWindow.hide();
    }
  });

  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}

function notifyDashboard(event, data) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send(event, data);
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Both command line and simple double-click should now trigger the Dashboard
    createDashboardWindow();
  });
}

/**
 * Captures currently selected text by simulating Ctrl+C
 */
async function captureSelectedText() {
  const oldClipboard = clipboard.readText();
  clipboard.clear();

  // Simulate Ctrl+C
  const vbs = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.SendKeys "^c"\n`;
  const vbsPath = path.join(require('os').tmpdir(), `leelacopy_${Date.now()}.vbs`);
  fs.writeFileSync(vbsPath, vbs);

  return new Promise((resolve) => {
    exec(`wscript //B "${vbsPath}"`, { windowsHide: true }, async () => {
      try { fs.unlinkSync(vbsPath); } catch (_) { }

      // Wait for clipboard update
      await new Promise(r => setTimeout(r, 150));
      const selection = clipboard.readText();

      // Restore original clipboard if we're not going to polish (but actually we'll do it later if we DO polish)
      // For now, return what we found
      resolve({ selection, oldClipboard });
    });
  });
}

/**
 * Polishes text using Sarvam Chat API
 */
async function polishText(text) {
  const apiKey = secretManager.getApiKey();
  if (!apiKey) throw new Error('Sarvam API Key not found. Please set it in Settings.');

  const prompt = `Fix grammar and sentence structure of the following text while strictly preserving the original tone, style, and manner of the user input. Do not make it overly formal if the input is casual. Do not add new information. Return ONLY the corrected text.\n\nTEXT:\n${text}`;

  const response = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
    model: 'sarvam-m',
    messages: [
      { role: 'system', content: 'You are a professional grammar and tone preservation assistant. Always return only the corrected text, nothing else.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1
  }, {
    headers: { 'api-subscription-key': apiKey },
    timeout: 30000
  });

  let content = response.data?.choices?.[0]?.message?.content || text;
  return content.trim();
}

/**
 * Sync the "Run on Startup" setting with Windows using Electron's API
 */
function syncStartupSetting() {
  const settings = settingsManager.getSettings();
  const startWithWindows = settings.startWithWindows;

  console.log(`[LeelaV1] Syncing startup setting: ${startWithWindows}`);

  try {
    app.setLoginItemSettings({
      openAtLogin: startWithWindows,
      path: process.execPath,
      args: [
        path.resolve(__dirname)
      ]
    });
    console.log(`[LeelaV1] Successfully ${startWithWindows ? 'registered' : 'unregistered'} for startup.`);
  } catch (e) {
    console.error('[LeelaV1] Failed to sync startup setting:', e);
  }
}

app.whenReady().then(() => {
  createTray();

  // createWindow() removed
  createDashboardWindow(); // Single UI window (will show setup or dashboard internally)

  createStatusWindow();

  // Handle command line flags
  if (process.argv.includes('--dashboard')) {
    createDashboardWindow();
  }
  // Register a global hotkey (Control+Space)
  try {
    const registered = globalShortcut.register('Control+Space', async () => {
      if (isProcessingHotkey) return;
      isProcessingHotkey = true;

      console.log('[LeelaV1] Global hotkey triggered: Control+Space');

      // Check if we are in dictation mode (no selection) or polish mode (text selected)
      const { selection, oldClipboard } = await captureSelectedText();

      console.log('[LeelaV1] Global hotkey triggered: Control+Space');

      try {
        const { selection, oldClipboard } = await captureSelectedText();

        if (selection && selection.trim().length > 0) {
          console.log('[LeelaV1] Text selection detected. Entering POLISH MODE.');
          updateState(AppStates.PROCESSING);
          if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send('play-command-sound');
          }

          try {
            const polished = await polishText(selection);
            console.log('[LeelaV1] Text polished successfully.');

            if (settingsManager.getSettings().historyEnabled) {
              activityLogger.logAction({
                type: 'Text Polish',
                input: selection,
                output: polished,
                status: 'SUCCESS'
              });
              notifyDashboard('history-updated');
            }

            clipboard.writeText(polished);
            const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWScript.Sleep 100\nWshShell.SendKeys "^v"\n`;
            const vbsPath = path.join(require('os').tmpdir(), `leelapaste_polish_${Date.now()}.vbs`);
            fs.writeFileSync(vbsPath, vbsScript);

            exec(`wscript //B "${vbsPath}"`, { windowsHide: true }, () => {
              try { fs.unlinkSync(vbsPath); } catch (_) { }
              setTimeout(() => {
                clipboard.writeText(oldClipboard);
                isProcessingHotkey = false;
                updateState(AppStates.SUCCESS_POLISH);
              }, 500);
            });
            return;
          } catch (err) {
            console.error('[LeelaV1] Polish failed:', err.message);
            updateState(AppStates.ERROR);
            if (settingsManager.getSettings().historyEnabled) {
              activityLogger.logAction({
                type: 'Text Polish',
                input: selection,
                output: err.message,
                status: 'ERROR'
              });
              notifyDashboard('history-updated');
            }
            clipboard.writeText(oldClipboard);
            isProcessingHotkey = false;
          }
        } else {
          console.log('[LeelaV1] No selection. Entering DICTATION MODE.');
          if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send('hotkey-toggle');
          }
          // The Dictation Mode hotkey toggle is instantaneous on the main process side.
          // The renderer handles the actual recording length and API transcription logic.
          isProcessingHotkey = false;
        }
      } catch (err) {
        console.error('[LeelaV1] Hotkey processing error:', err);
        isProcessingHotkey = false;
      }
    });

    if (!registered) {
      console.error('[LeelaV1] Failed to register Control+Space');
    }
  } catch (e) {
    console.error('[LeelaV1] Error setting up global shortcut:', e);
  }
  // Sync startup setting on launch
  syncStartupSetting();

  // Start background cleanup (silent)
  cleanup.initCleanup(__dirname);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createDashboardWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Ensure we unregister global shortcuts on quit
app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
    console.log('[LeelaV1] Unregistered all global shortcuts');
  } catch (e) {
    console.error('[LeelaV1] Error unregistering global shortcuts:', e);
  }
});

// Paste text into the currently focused application by writing to clipboard and sending Ctrl+V
ipcMain.handle('paste-text', async (event, text) => {
  try {
    if (!text) return { ok: false, error: 'empty' };
    console.log('[LeelaV1] Pasting transcript:', text.substring(0, 50) + '...');
    clipboard.writeText(String(text));

    if (process.platform === 'win32') {
      // Use VBScript with a delay to ensure focus returns to target app
      const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWScript.Sleep 300\nWshShell.SendKeys "^v"\nWScript.Sleep 50\n`;
      const vbsPath = path.join(require('os').tmpdir(), `leelapaste_${Date.now()}.vbs`);
      fs.writeFileSync(vbsPath, vbsScript);
      exec(`wscript //B "${vbsPath}"`, { windowsHide: true }, (err) => {
        try { fs.unlinkSync(vbsPath); } catch (_) { }
      });
    } else {
      // Fallback for other platforms
      console.warn('[LeelaV1] Auto-paste not robust on this platform');
    }

    return { ok: true };
  } catch (e) {
    console.error('[LeelaV1] paste-text handler error:', e);
    return { ok: false, error: String(e) };
  }
});

// Receive renderer log messages and persist to file for debugging
ipcMain.on('renderer-log', (event, level, msg) => {
  try {
    const logLine = `${new Date().toISOString()} [${level}] ${String(msg)}\n`;
    fs.appendFileSync(path.join(__dirname, 'renderer.log'), logLine);
  } catch (e) {
    console.error('[LeelaV1] Failed to write renderer.log', e);
  }
});

/**
 * Convert .webm to .wav (16kHz, mono) and transcribe via Sarvam synchronous API
 */
const util = require('util');
const execAsync = util.promisify(exec);

/**
 * Convert .webm to .wav (16kHz, mono) and transcribe via Sarvam synchronous API.
 * Handles long audio by chunking into 25s segments using FFmpeg.
 */
async function transcribeSynchronous(webmPath, apiKey) {
  const baseName = path.basename(webmPath, '.webm');
  const tempDir = path.dirname(webmPath);
  const wavPath = path.join(tempDir, `${baseName}_full.wav`);
  const chunkPattern = path.join(tempDir, `${baseName}_chunk_%03d.wav`);

  try {
    console.log('[RECORDER] Converting to WAV asynchronously:', webmPath);
    // Convert to 16k, mono, 16bit WAV without blocking the event loop
    const convCmd = `"${ffmpeg}" -i "${webmPath}" -ar 16000 -ac 1 -c:a pcm_s16le -y "${wavPath}"`;
    await execAsync(convCmd);

    console.log('[RECORDER] Chunking audio if needed...');
    // Split into 25s chunks without blocking
    const splitCmd = `"${ffmpeg}" -i "${wavPath}" -f segment -segment_time 25 -c copy "${chunkPattern}"`;
    await execAsync(splitCmd);

    // Identify chunk files
    const files = fs.readdirSync(tempDir);
    const chunkFiles = files
      .filter(f => f.startsWith(`${baseName}_chunk_`) && f.endsWith('.wav'))
      .sort()
      .map(f => path.join(tempDir, f));

    console.log(`[LeelaV1] Processing ${chunkFiles.length} chunks...`);
    const transcripts = [];

    for (const chunk of chunkFiles) {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(chunk), {
        filename: 'audio.wav',
        contentType: 'audio/wav'
      });
      formData.append('model', 'saaras:v3');
      formData.append('mode', 'translate');
      formData.append('targetLanguage', 'en');

      try {
        const response = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
          headers: {
            ...formData.getHeaders(),
            'api-subscription-key': apiKey
          },
          timeout: 45000 // Increased timeout for individual chunks
        });

        if (response.data && response.data.transcript) {
          transcripts.push(response.data.transcript.trim());
        }
      } catch (err) {
        console.error(`[LeelaV1] Chunk transcription segment failed:`, err.message);
      } finally {
        // Cleanup chunk file immediately
        try { fs.unlinkSync(chunk); } catch (_) { }
      }
    }

    if (transcripts.length === 0) {
      return { ok: false, error: 'transcription_failed' };
    }

    const finalTranscript = transcripts.join(' ');
    console.log('[LeelaV1] Combined Transcript:', finalTranscript.substring(0, 100) + '...');
    return { ok: true, text: finalTranscript };

  } catch (err) {
    console.error('[LeelaV1] Synchronous transcription error:', err.message);
    return { ok: false, error: err.message };
  } finally {
    // Cleanup temporary full wav
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (_) { }
  }
}

// Process a saved recording using Sarvam synchronous API and paste result
ipcMain.handle('process-recording', async (event, filePath) => {
  updateState(AppStates.PROCESSING);
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      updateState(AppStates.ERROR);
      return { ok: false, error: 'file_missing' };
    }

    // Load API key from secret manager
    const apiKey = secretManager.getApiKey();
    if (!apiKey) {
      updateState(AppStates.ERROR);
      return { ok: false, error: 'no_api_key' };
    }

    console.log('[LeelaV1] Starting fast-path transcription for:', filePath);
    updateState(AppStates.PROCESSING);
    const result = await transcribeSynchronous(filePath, apiKey);

    if (result.ok && result.text) {
      const transcript = result.text.trim();
      console.log('[LeelaV1] Transcript received:', transcript);

      let finalResult = transcript;
      try {
        console.log('[LeelaV1] Auto-polishing transcription...');
        finalResult = await polishText(transcript);
        console.log('[LeelaV1] Transcription polished.');
      } catch (err) {
        console.warn('[LeelaV1] Auto-polish failed, using raw transcript:', err.message);
      }

      // Paste using the robust VBScript method
      clipboard.writeText(String(finalResult));
      if (process.platform === 'win32') {
        const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWScript.Sleep 400\nWshShell.SendKeys "^v"\nWScript.Sleep 50\n`;
        const vbsPath = path.join(require('os').tmpdir(), `leelapaste_fast_${Date.now()}.vbs`);
        fs.writeFileSync(vbsPath, vbsScript);
        exec(`wscript //B "${vbsPath}"`, { windowsHide: true }, (err) => {
          try { fs.unlinkSync(vbsPath); } catch (_) { }
          if (err) {
            console.error('[LeelaV1] Failed to paste:', err);
            updateState(AppStates.ERROR);
          } else {
            updateState(AppStates.SUCCESS_PASTE);
            // Log activity
            if (settingsManager.getSettings().historyEnabled) {
              activityLogger.logAction({
                type: 'Voice Dictation',
                input: transcript,
                output: finalResult,
                status: 'SUCCESS'
              });
              notifyDashboard('history-updated');
            }
          }
        });
      }
      return { ok: true, text: transcript };
    }

    updateState(AppStates.ERROR);
    return { ok: false, error: result.error || 'no_transcript' };
  } catch (e) {
    updateState(AppStates.ERROR);
    console.error('[API] process-recording error:', e);
    return { ok: false, error: String(e) };
  } finally {
    // Immediate and explicit cleanup of the input webm file
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { }
    cleanup.runCleanup(__dirname);
  }
});

// IPC Handlers for Dashboard & Settings
ipcMain.handle('get-history', () => {
  return activityLogger.getHistory();
});

ipcMain.handle('get-settings', () => {
  return settingsManager.getSettings();
});

ipcMain.on('update-setting', (event, newSetting) => {
  const oldSettings = settingsManager.getSettings();
  settingsManager.updateSettings(newSetting);

  // If startWithWindows was changed, sync it
  if (newSetting.hasOwnProperty('startWithWindows') && newSetting.startWithWindows !== oldSettings.startWithWindows) {
    syncStartupSetting();
  }
});

ipcMain.on('open-dashboard', () => {
  createDashboardWindow();
});

// Added to allow renderer to update global state
ipcMain.on('update-app-state', (event, state) => {
  updateState(AppStates[state] || state);
});

// Sarvam API Key Management IPC
ipcMain.handle('test-sarvam-key', async (event, key) => {
  try {
    const testKey = key || secretManager.getApiKey();
    if (!testKey) return { ok: false, error: 'No API key provided or stored.' };

    // Lightweight check: use Chat API
    const response = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
      model: 'sarvam-m',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1
    }, {
      headers: { 'api-subscription-key': testKey },
      timeout: 5000
    });

    return { ok: true };
  } catch (err) {
    console.error('[LeelaV1] API Key test failed:', err.response?.data || err.message);
    return { ok: false, error: err.response?.data?.message || err.message };
  }
});

ipcMain.handle('save-sarvam-key', async (event, key) => {
  const success = secretManager.setApiKey(key);
  if (success) {
    // Notify dashboard to refresh its view
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('key-saved');
    }
    createWindow(); // Re-ensure dictation window is ready
  }
  return success;
});

ipcMain.handle('remove-sarvam-key', () => {
  return secretManager.removeApiKey();
});

ipcMain.handle('has-sarvam-key', () => {
  return secretManager.hasApiKey();
});

