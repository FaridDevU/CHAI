import { describe, expect, test } from "bun:test"
import { MessageRouter } from "./router"

describe("MessageRouter", () => {
  test("stamps id + timestamp and records history", () => {
    const router = new MessageRouter()
    const msg = router.send({ from: "coordinator", to: "a1", type: "pregunta", text: "hola" })

    expect(msg.id).toBeTruthy()
    expect(msg.timestamp).toBeGreaterThan(0)
    expect(router.history()).toHaveLength(1)
    expect(router.history()[0]?.text).toBe("hola")
  })

  test("notifies subscribers and respects unsubscribe", () => {
    const router = new MessageRouter()
    const seen: string[] = []
    const off = router.subscribe((m) => seen.push(m.text))

    router.send({ from: "a", to: "b", type: "info", text: "one" })
    off()
    router.send({ from: "a", to: "b", type: "info", text: "two" })

    expect(seen).toEqual(["one"])
  })

  test("filters subscribers and conversations by participant", () => {
    const router = new MessageRouter()
    const toA: string[] = []
    router.subscribe((m) => toA.push(m.text), (m) => m.to === "a1")

    router.send({ from: "coordinator", to: "a1", type: "info", text: "for-a" })
    router.send({ from: "coordinator", to: "a2", type: "info", text: "for-b" })

    expect(toA).toEqual(["for-a"])
    expect(router.conversation("a1")).toHaveLength(1)
    expect(router.conversation("coordinator")).toHaveLength(2)
  })

  test("trims history to the configured limit", () => {
    const router = new MessageRouter({ historyLimit: 2 })
    router.send({ from: "a", to: "b", type: "info", text: "1" })
    router.send({ from: "a", to: "b", type: "info", text: "2" })
    router.send({ from: "a", to: "b", type: "info", text: "3" })

    expect(router.history().map((m) => m.text)).toEqual(["2", "3"])
  })
})
