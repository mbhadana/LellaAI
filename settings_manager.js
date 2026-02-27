const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const DEFAULT_SETTINGS = {
    overlayEnabled: true,
    hotkey: 'Control+Space',
    historyEnabled: true,
    historyRetentionLimit: 200,
    startWithWindows: false
};

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            settings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
        } catch (e) {
            console.error('[SettingsManager] Failed to load settings:', e);
        }
    } else {
        saveSettings();
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('[SettingsManager] Failed to save settings:', e);
    }
}

function getSettings() {
    return { ...settings };
}

function updateSettings(newSettings) {
    settings = { ...settings, ...newSettings };
    saveSettings();
    return settings;
}

// Initial load
loadSettings();

module.exports = {
    getSettings,
    updateSettings
};
