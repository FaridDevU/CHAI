import { type ComponentProps } from "solid-js"

// CHAI brand assets live in the renderer public dir (packages/app/public),
// served at the site root for both the web app and the desktop renderer.
const ICON = "/chai-icon.png"
const FULL = "/chai-logo.png"

// Compact icon-only mark for tight spaces (tabs, side panels).
export const Mark = (props: { class?: string }) => {
  return (
    <img
      data-component="logo-mark"
      src={ICON}
      alt="CHAI"
      classList={{ "object-contain": true, [props.class ?? ""]: !!props.class }}
    />
  )
}

// Hero mark used on splash / loading screens.
export const Splash = (props: Pick<ComponentProps<"img">, "ref" | "class">) => {
  return (
    <img
      ref={props.ref}
      data-component="logo-splash"
      src={ICON}
      alt="CHAI"
      classList={{ "object-contain": true, [props.class ?? ""]: !!props.class }}
    />
  )
}

// Full horizontal lockup (icon + wordmark) for headers and watermarks.
export const Logo = (props: { class?: string }) => {
  return (
    <img
      data-component="logo-full"
      src={FULL}
      alt="CHAI"
      classList={{ "object-contain": true, [props.class ?? ""]: !!props.class }}
    />
  )
}
