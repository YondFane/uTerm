import argparse
import os
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--name", default="Python demo")
parser.add_argument("--fail", action="store_true")
args = parser.parse_args()
print(f"START {args.name} · 中文日志")
print(f"VALUE={os.environ.get('VALUE', '')}")
print("STDERR 中文日志", file=sys.stderr)
for index in range(20):
    print(f"heartbeat {index + 1}")
    time.sleep(0.5)
if args.fail:
    raise RuntimeError("Python fixture exception")
print("COMPLETE 中文日志")
