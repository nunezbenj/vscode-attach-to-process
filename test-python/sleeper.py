"""Long-running loop used by the tests and for trying the extension by hand.

Run it from any terminal:  python3 test-python/sleeper.py --tag demo
Then set a breakpoint on the `total += n` line and attach from VS Code.
"""
import argparse
import time


def work(n: int) -> int:
    return n * 2


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", default="sleeper")
    args = parser.parse_args()
    total = 0
    i = 0
    while True:
        i += 1
        n = work(i)
        total += n  # <- breakpoint here
        if i % 10 == 0:
            print(f"[{args.tag}] tick {i} total={total}", flush=True)
        time.sleep(1)


if __name__ == "__main__":
    main()
