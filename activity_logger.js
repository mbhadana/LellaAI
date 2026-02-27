const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'activity_history.json');

function logAction({ type, input, output, status }) {
    try {
        let history = [];
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            history = JSON.parse(data);
        }

        const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            type,
            input: input || '',
            output: output || '',
            status
        };

        history.unshift(entry);

        // Limit to 200 entries
        if (history.length > 200) {
            history = history.slice(0, 200);
        }

        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
        console.log(`[ActivityLogger] Logged ${type}: ${status}`);
    } catch (e) {
        console.error('[ActivityLogger] Failed to log action:', e);
    }
}

function getHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('[ActivityLogger] Failed to get history:', e);
    }
    return [];
}

module.exports = {
    logAction,
    getHistory
};
