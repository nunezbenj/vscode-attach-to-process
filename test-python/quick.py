"""Finishes in a blink — the kind of run you cannot catch in a process list.

Run it with the wait helper and it pauses until the debugger is attached:
    python3 resources/waitattach.py test-python/quick.py --n 3
Put a breakpoint on the `total += i` line first; it is hit on the very first iteration.
"""
import argparse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=3)
    args = parser.parse_args()
    total = 0
    for i in range(args.n):
        total += i  # <- breakpoint here
    print(f"total={total}", flush=True)


if __name__ == "__main__":
    main()
