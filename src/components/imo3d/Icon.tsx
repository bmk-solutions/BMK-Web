export function Icon({name,size=21}:{name:string;size?:number}) {
  const paths:Record<string,React.ReactNode>={
    "rotate-left":<><path d="M3 10a9 9 0 1 1 2 9M3 4v6h6"/></>,
    "rotate-right":<><path d="M21 10a9 9 0 1 0-2 9m2-15v6h-6"/></>,
    compass:<><circle cx="12" cy="12" r="9"/><path d="m15 9-2 4-4 2 2-4Z"/></>,
    grid:<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    map:<><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/></>,
    home:<><path d="m3 10 9-7 9 7v11H3Z"/><path d="M9 21v-8h6v8"/></>,
    upload:<><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></>,
    plus:<path d="M12 4v16M4 12h16"/>,close:<path d="m6 6 12 12M18 6 6 18"/>,
    arrow:<path d="m15 5-7 7 7 7M8 12h13"/>,
    expand:<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>,
    measure:<><path d="m3 16 13-13 5 5L8 21Z"/><path d="m12 7 2 2m-5 1 2 2m-5 1 2 2"/></>,
    info:<><circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 6v1"/></>,
    "eye-off":<><path d="m3 3 18 18M9 5c1-.3 2-.4 3-.4 6 0 10 7.4 10 7.4s-1.4 2.5-3.8 4.5M6 6.5C3.5 8.5 2 12 2 12s4 7 10 7c1.9 0 3.5-.6 4.9-1.4M10 10a3 3 0 0 0 4 4"/></>,
    eye:<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    link:<><path d="m10 7 2-2a5 5 0 0 1 7 7l-2 2M14 17l-2 2a5 5 0 0 1-7-7l2-2M8 16l8-8"/></>,
    layers:<><path d="m12 3 10 5-10 5L2 8Z"/><path d="m2 12 10 5 10-5M2 16l10 5 10-5"/></>,
    check:<path d="m4 12 5 5L20 6"/>,search:<><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></>,
    people:<><circle cx="9" cy="7" r="3"/><path d="M2 21v-4a7 7 0 0 1 14 0v4M17 4a3 3 0 0 1 0 6m1 4c3 0 4 3 4 7"/></>,
    folder:<path d="M3 6V3h6l3 3h9v15H3Z"/>,
    play:<path d="m8 4 12 8-12 8Z"/>,
    trash:<><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></>,
    settings:<><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.info}</svg>;
}
