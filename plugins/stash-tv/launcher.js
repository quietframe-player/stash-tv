(function () {
  const api = window.PluginApi;
  const React = api.React;
  const { useLocation } = api.libraries.ReactRouterDOM;

  function Launcher() {
    const location = useLocation();
    const base = document.querySelector("base")?.href || window.location.origin + "/";
    const url = new URL("plugin/stash-tv/assets/index.html", base);
    const scene = location.pathname.match(/^\/scenes\/([1-9][0-9]*)\/?$/);
    if (scene) url.searchParams.set("scene", scene[1]);
    url.searchParams.set("autoplay", "true");
    const seed = new URLSearchParams(location.search).get("qsort")?.match(/^random_(\d+)$/);
    if (seed) url.searchParams.set("seed", seed[1]);
    return React.createElement(
      "a",
      { href: url.href, className: "nav-utility minimal btn", title: "Open Stash TV", "aria-label": "Open Stash TV" },
      React.createElement(api.components.Icon, { icon: api.libraries.FontAwesomeSolid.faTv }),
    );
  }

  api.patch.before("MainNavBar.UtilityItems", function (props) {
    return [{ ...props, children: React.createElement(React.Fragment, null, props.children, React.createElement(Launcher)) }];
  });
})();
