# ref_cas_lab.py: many writers, one ref store, compare-and-swap
import asyncio, time

RTT = 0.010  # assumed 10 ms round trip to the ref store

class RefStore:
    def __init__(self, one_at_a_time=False):
        self.refs, self.ok, self.rejected = {}, 0, 0
        self.gate = asyncio.Lock() if one_at_a_time else None  # serialized model

    async def read(self, ref):
        await asyncio.sleep(RTT)
        return self.refs.get(ref)

    async def cas(self, ref, expected, new):
        if self.gate:
            async with self.gate:
                return await self._cas(ref, expected, new)
        return await self._cas(ref, expected, new)

    async def _cas(self, ref, expected, new):
        await asyncio.sleep(RTT / 2)          # request travels
        ok = self.refs.get(ref) == expected   # the compare
        if ok:
            self.refs[ref] = new              # the swap
            self.ok += 1
        else:
            self.rejected += 1
        await asyncio.sleep(RTT / 2)          # reply travels
        return ok

async def agent(store, i, ref):
    while True:                               # read, build on top, try to swap
        old = await store.read(ref)
        if await store.cas(ref, old, f"c{i}-on-{old}"):
            return

async def run(label, agents, same_ref, one_at_a_time=False):
    store = RefStore(one_at_a_time)
    t = time.perf_counter()
    await asyncio.gather(*(agent(store, i, "main" if same_ref else f"agent-{i}")
                           for i in range(agents)))
    secs = time.perf_counter() - t
    print(f"{label:<42} ok={store.ok} rejected={store.rejected} time={secs:.2f}s")

async def main():
    await run("1,000 agents, own refs, parallel", 1000, False)
    await run("1,000 agents, own refs, serialized", 1000, False, True)
    await run("100 agents, all on main, parallel", 100, True)

asyncio.run(main())
