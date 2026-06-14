import { type ComponentProps } from "solid-js"

// CHAI wordmark served from the renderer public dir (packages/app/public).
const WORDMARK = "/chai-wordmark.png"

export function WordmarkV2(props: Pick<ComponentProps<"img">, "class">) {
  return (
    <img
      data-component="wordmark-v2"
      src={WORDMARK}
      alt="CHAI"
      // Keep the original subtle watermark feel: faint, fading toward the bottom.
      style={{
        opacity: "0.16",
        "object-fit": "contain",
        "-webkit-mask-image": "linear-gradient(to bottom, black 60%, transparent)",
        "mask-image": "linear-gradient(to bottom, black 60%, transparent)",
      }}
      classList={{ [props.class ?? ""]: !!props.class }}
    />
  )
}
