1. Ligar dc.windomain.local
2. Ligar wef.windomain.local
3. Ligar win10.windomain.local
4. Ligar logger

---

ssh vagrant@192.168.56.105

---

Hosting the web page

cd ~/soc-agent
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000