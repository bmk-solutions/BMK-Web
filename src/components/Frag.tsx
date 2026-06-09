import { FRAGS } from "@/content/frags";

/**
 * Server component that renders a pre-built, tested HTML section fragment.
 * Fragments live (as a bundled string map) in src/content/frags.ts and are
 * generated from the verified static site. Interactivity is wired globally
 * by /public/assets/js/site.js (loaded in the root layout).
 */
export default function Frag({ name }: { name: string }) {
  const html = FRAGS[name] ?? "";
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
