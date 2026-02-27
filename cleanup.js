const fs = require('fs');
const path = require('path');

/**
 * Cleanup service for LeelaV1
 * Monitors the application directory for recording files and removes old ones.
 */

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const RECORDING_PATTERN = /^recording-.*\.webm$/;
const TRANSCODE_PATTERN = /^transcode-.*\.wav$/;

function runCleanup(baseDir) {
    try {
        const files = fs.readdirSync(baseDir);
        const now = Date.now();

        // Group files by type to find the "latest" of each separately if needed, 
        // but the requirement says "not the most recently created file" generally.
        // We'll treat all recordings/transcodes as part of the same lifecycle.

        const audioFiles = files
            .filter(f => RECORDING_PATTERN.test(f) || TRANSCODE_PATTERN.test(f))
            .map(f => {
                const fullPath = path.join(baseDir, f);
                const stats = fs.statSync(fullPath);
                return { name: f, path: fullPath, mtime: stats.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime); // Newest first

        if (audioFiles.length <= 1) return;

        // Keep the newest file, delete others if they are old OR just not the newest
        audioFiles.slice(1).forEach(file => {
            const age = now - file.mtime;

            // Delete if older than limit OR simply because it's not the latest
            // (Requirement 4 says OLDER than limit OR not most recent)
            try {
                fs.unlinkSync(file.path);
                console.log(`[CLEANUP] Deleted old/redundant file: ${file.name} (Age: ${Math.round(age / 1000)}s)`);
            } catch (e) {
                // Silently ignore files in use (Requirement 5 & 8)
                if (e.code !== 'EBUSY' && e.code !== 'EPERM') {
                    console.warn(`[CLEANUP] Could not delete ${file.name}:`, e.message);
                }
            }
        });

    } catch (err) {
        console.error('[CLEANUP] Error during background task:', err.message);
    }
}

/**
 * Initializes the background cleanup timer
 */
function initCleanup(baseDir, intervalMs = 10 * 60 * 1000) {
    console.log(`[CLEANUP] Initialized background service (Interval: ${intervalMs / 1000}s)`);

    // Run once immediately
    runCleanup(baseDir);

    // Set up periodic timer
    return setInterval(() => {
        runCleanup(baseDir);
    }, intervalMs);
}

module.exports = { runCleanup, initCleanup };
