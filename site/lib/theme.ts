// Light/dark: the page follows the visitor's system setting until they press the toggle; the choice is then kept in
// this browser. Runs before first paint so the page never flashes the wrong theme.
export const THEME_KEY = "watchbell-site-theme";

export const themeInitScript = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(s==="light"||s==="dark")document.documentElement.dataset.theme=s;}catch(e){}})();`;
