1. Ligar dc.windomain.local
2. Ligar wef.windomain.local
3. Ligar win10.windomain.local
4. Ligar logger

---

ssh vagrant@192.168.56.105

---

Hosting the backend

ssh vagrant@192.168.56.105

cd ~/soc-agent
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000

---

Hosting the next web proxy and page

ssh vagrant@192.168.56.105

cd ~/soc-agent/frontend
npm run dev -- --host 0.0.0.0

---

if npm is not installed
npm install

---

if npm is missing
sudo apt update
sudo apt install nodejs npm -y
node -v
npm -v

---

Prod usar:

cd ~/soc-agent/frontend
npm run build
npm run start -- -H 0.0.0.0

---

Playwright video

on frontend/

# RECORD DEMO
npm run demo:record
npm run demo:roles:video

# RECORD ROLES audit video
npm run test:roles:video

on the repo page
ffmpeg -y -i demo-output/soc-ai-agent-demo.webm demo-output/soc-ai-agent-demo.mp4


For audit Videos
ffmpeg -y -i tests-output\role-viewer.webm tests-output\role-viewer.mp4
ffmpeg -y -i tests-output\role-analyst.webm tests-output\role-analyst.mp4
ffmpeg -y -i tests-output\role-admin.webm tests-output\role-admin.mp4

for role videos
Get-ChildItem "D:\TRABALHO SOC\soc-agent\demo-output" -Recurse -Filter *.webm | ForEach-Object {
  $out = [System.IO.Path]::ChangeExtension($_.FullName, ".mp4")

  ffmpeg -y -i $_.FullName `
    -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p -movflags +faststart `
    -c:a aac -b:a 192k `
    $out
}

or 

ffmpeg -y -i "D:\TRABALHO SOC\soc-agent\demo-output\roles\role-viewer.webm" `
  -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p -movflags +faststart `
  -c:a aac -b:a 192k `
  "D:\TRABALHO SOC\soc-agent\demo-output\roles\role-viewer.mp4"