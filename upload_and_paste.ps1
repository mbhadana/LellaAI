# Upload recording to OpenAI Whisper (uses OPENAI_API_KEY from voice-writer-ai\.env) and paste transcript
try {
  $envPath = 'C:\Users\admin\Documents\SpeechToTextAI\voice-writer-ai\.env'
  if (-not (Test-Path $envPath)) { Write-Error 'Env file not found'; exit 2 }
  $envText = Get-Content $envPath -Raw
  $lines = $envText -split '\r?\n' | Where-Object { $_ -match '=' }
  $h = @{}
  foreach ($l in $lines) {
    $parts = $l -split '=', 2
    if ($parts.Length -ge 2) {
      $k = $parts[0].Trim()
      $v = $parts[1].Trim().Trim('"')
      $h[$k] = $v
    }
  }
  $key = $h['OPENAI_API_KEY']
  if (-not $key) { Write-Error 'OPENAI_API_KEY not found in .env'; exit 3 }

  $filePath = 'C:\Users\admin\LeelaV1\recording-1772021409596.webm'
  if (-not (Test-Path $filePath)) { Write-Error 'Recording file not found'; exit 4 }

  Write-Output 'Uploading...'
  # Build multipart/form-data POST using HttpClient (compatibility across PS versions)
  # Ensure System.Net.Http types are loaded
  try { Add-Type -AssemblyName System.Net.Http } catch {}
  $bytes = [System.IO.File]::ReadAllBytes($filePath)
  $content = New-Object System.Net.Http.MultipartFormDataContent
  $fileContent = [System.Net.Http.ByteArrayContent]::new($bytes)
  $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('audio/webm')
  $content.Add($fileContent, 'file', 'recording.webm')
  $content.Add([System.Net.Http.StringContent]::new('whisper-1'), 'model')

  $client = New-Object System.Net.Http.HttpClient
  $client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $key)
  $respMsg = $client.PostAsync('https://api.openai.com/v1/audio/transcriptions', $content).Result
  if (-not $respMsg.IsSuccessStatusCode) {
    $body = $respMsg.Content.ReadAsStringAsync().Result
    Write-Error \"HTTP $($respMsg.StatusCode): $body\"
    exit 7
  }
  $respText = $respMsg.Content.ReadAsStringAsync().Result
  try { $resp = $respText | ConvertFrom-Json } catch { $resp = $respText }
  if (-not $resp) { Write-Error 'No response'; exit 5 }
  $trans = $resp.text
  if (-not $trans) { Write-Error 'No transcript in response'; exit 6 }

  # Save transcript to a file for record
  $outFile = Join-Path (Split-Path $filePath) ('transcript-' + (Get-Date -UFormat %s) + '.txt')
  $trans | Out-File -FilePath $outFile -Encoding UTF8
  Write-Output "Transcript saved to $outFile"

  # Copy to clipboard and paste into active window
  Set-Clipboard -Value $trans
  Start-Sleep -Milliseconds 200
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Write-Output 'TRANSCRIBED_OK'
} catch {
  Write-Error "Error: $_"
  exit 9
}

