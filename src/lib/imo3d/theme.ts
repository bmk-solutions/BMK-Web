/**
 * Light and dark for the tour studio and the buyer's viewer (owner, 2026-09-08: every app carries
 * both). The choice lives under «bmk-theme», the key the studio suite already uses on
 * os.bmk.solutions, so the tour follows whatever the owner last chose anywhere in the suite.
 * `system` (or nothing stored) follows the device and keeps following it when it changes.
 *
 * The resolved theme is `data-imo-theme` on <html>, set before the first paint by THEME_BOOT_SCRIPT;
 * the marketing site's own `data-theme` is left alone.
 *
 * Isomorphic: no Node or browser APIs outside the boot script string.
 */
export const THEME_KEY="bmk-theme";
export type ThemeChoice="system"|"light"|"dark";
export type Theme="light"|"dark";
export const themeChoice=(stored:string|null|undefined):ThemeChoice=>stored==="light"||stored==="dark"?stored:"system";
export const resolveTheme=(choice:ThemeChoice,prefersLight:boolean):Theme=>choice==="system"?(prefersLight?"light":"dark"):choice;
/** The toggle flips what is on screen; landing back on the device's own theme returns to following it. */
export function nextThemeChoice(shown:Theme,prefersLight:boolean):ThemeChoice{
 const target:Theme=shown==="dark"?"light":"dark";
 return target===(prefersLight?"light":"dark")?"system":target;
}
export const THEME_BOOT_SCRIPT=`(()=>{var k=${JSON.stringify(THEME_KEY)},q=matchMedia("(prefers-color-scheme: light)"),a=function(){var m=null;try{m=localStorage.getItem(k)}catch(e){}var t=m==="light"||m==="dark"?m:q.matches?"light":"dark";document.documentElement.dataset.imoTheme=t;document.documentElement.style.colorScheme=t};a();q.addEventListener("change",a);addEventListener("storage",function(e){if(e.key===k)a()})})()`;
