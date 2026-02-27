const fs = require('fs');
const path = require('path');
const axios = require('axios');

async function run() {
  const { SarvamAIClient } = require('sarvamai');
  const cfgPath = path.join(__dirname, 'config.json');
  let apiKey = process.env.SARVAM_API_KEY;
  if (fs.existsSync(cfgPath)) {
    try { const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); apiKey = apiKey || cfg.apiKey; } catch { }
  }
  if (!apiKey) { console.error('No SARVAM API key'); process.exit(2); }

  const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });

  const files = fs.readdirSync(__dirname).filter(f => f.startsWith('recording-') && f.endsWith('.webm'));
  if (files.length === 0) { console.error('No recording files'); process.exit(3); }
  const filePath = path.join(__dirname, files[files.length - 1]);

  console.log('Creating batch job...');
  const job = await client.speechToTextJob.createJob({
    model: 'saaras:v3',
    mode: 'translate',          // request translation to target language
    languageCode: 'unknown',
    targetLanguage: 'en',       // request English translation
    withDiarization: false
  });

  console.log('Uploading file...');
  await job.uploadFiles([filePath]);

  console.log('Starting job...');
  await job.start();

  console.log('Waiting for completion...');
  await job.waitUntilComplete();

  const fileResults = await job.getFileResults();
  console.log('File results', fileResults);

  if (fileResults.successful && fileResults.successful.length > 0) {
    const outDir = path.join(__dirname, 'sarvam_outputs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    await job.downloadOutputs(outDir);
    console.log('Downloaded outputs to', outDir);
    // Try to find a transcript file in the output dir
    const outs = fs.readdirSync(outDir);
    const transcriptFile = outs.find(f => f.toLowerCase().includes('transcript') || f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.json'));
    if (transcriptFile) {
      const text = fs.readFileSync(path.join(outDir, transcriptFile), 'utf8');
      console.log('Transcript content:', text);

      // Auto-polish
      let finalResult = text;
      try {
        console.log('Polishing transcript...');
        const polishPrompt = `Fix grammar and sentence structure of the following text while strictly preserving the original tone, style, and manner of the user input. Do not make it overly formal if the input is casual. Do not add new information. Return ONLY the corrected text.\n\nTEXT:\n${text}`;
        const polishRes = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
          model: 'sarvam-m',
          messages: [
            { role: 'system', content: 'You are a professional grammar and tone preservation assistant. Always return only the corrected text, nothing else.' },
            { role: 'user', content: polishPrompt }
          ],
          temperature: 0.1
        }, {
          headers: { 'api-subscription-key': apiKey },
          timeout:
            30000
        });
        finalResult = polishRes.data?.choices?.[0]?.message?.content?.trim() || text;
        console.log('Polished Transcript:', finalResult);
      } catch (e) {
        console.warn('Polishing failed, using original transcript:', e.message);
      }

      // write to clipboard and paste (Windows)
      try {
        const { exec } = require('child_process');
        const tmpTextPath = path.join(outDir, 'tmp_transcript.txt');
        fs.writeFileSync(tmpTextPath, finalResult, 'utf8');
        // Use Windows clip utility to copy file contents to clipboard
        exec(`cmd /c type "${tmpTextPath}" | clip`, (err) => {
          if (err) {
            console.error('Clip failed', err);
            return;
          }
          // Paste via SendKeys
          exec('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"', (e2) => {
            if (e2) console.error('Paste failed', e2);
            else console.log('Pasted transcript to active window.');
          });
        });
      } catch (e) { console.error('Clipboard error', e); }
    } else {
      console.log('No transcript file found in outputs:', outs);
    }
  } else {
    console.error('No successful files in job result', fileResults);
  }
}

run().catch(err => { console.error(err); process.exit(1); });

