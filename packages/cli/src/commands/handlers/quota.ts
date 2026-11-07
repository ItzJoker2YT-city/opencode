import { EOL } from "os"
import { Effect, Option } from "effect"
import { QuotaLedger } from "@opencode/util/quota-ledger"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"

export default Runtime.handler(
  Commands.commands.quota,
  Effect.fn("cli.quota")(function* (input) {
    const key = Option.getOrUndefined(input.key)
    if (input.reset) {
      QuotaLedger.reset(key)
      process.stdout.write(`quota ledger reset${key === undefined ? "" : ` (${key})`}${EOL}`)
      return
    }
    const state = QuotaLedger.read()
    if (input.json) {
      process.stdout.write(JSON.stringify(state, null, 2) + EOL)
      return
    }
    const entries = Object.entries(state.buckets)
    if (entries.length === 0) {
      process.stdout.write(`no usage recorded today (${state.day})${EOL}`)
      return
    }
    for (const [name, bucket] of entries) {
      const gated =
        bucket.blockedUntil && bucket.blockedUntil > Date.now()
          ? ` blocked, resets ${QuotaLedger.humanize(bucket.blockedUntil)}`
          : ""
      const raw = bucket.resetRaw ? ` [${bucket.resetRaw}]` : ""
      process.stdout.write(`${name.padEnd(40)} used=${String(bucket.used).padStart(3)}${gated}${raw}${EOL}`)
    }
  }),
)
