import os

from flask import Flask

app = Flask(__name__)


@app.get("/health")
def health():
    return {"status": "ok", "framework": "flask", "value": os.environ.get("VALUE", "")}
