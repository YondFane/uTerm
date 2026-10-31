import os

from fastapi import FastAPI

app = FastAPI(title="uTerm Python fixture")


@app.get("/health")
def health():
    return {"status": "ok", "framework": "fastapi", "value": os.environ.get("VALUE", "")}
