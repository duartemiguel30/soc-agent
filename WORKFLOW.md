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