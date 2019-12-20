// ==UserScript==
// @name         Pinterest Downloader
// @namespace    pin_dl
// @version      0.4.0
// @description  Download content of Pinterest pages automatically
// @author       Marc Hage
// @include      http*://*.pinterest.*/*
// @require      https://unpkg.com/file-saver@1.3.8/FileSaver.min.js
// @require      https://unpkg.com/jszip@3.1.5/dist/jszip.min.js
// @require      https://unpkg.com/hyperapp@1.2.9/dist/hyperapp.js
// @license      MIT
// ==/UserScript==
/* global JSZip:false, saveAs:false, hyperapp:false */
/* jshint esversion: 6 */
/* jshint -W097 */
/* eslint-env greasemonkey, browser */
/* eslint curly: [2, 'multi'],wrap-iife: [2, 'inside'],indent: 2, 
comma-dangle: [2, "never"],strict: 0,no-confusing-arrow: 0,arrow-parens: 0,
no-plusplus: [2, { "allowForLoopAfterthoughts": true }],no-param-reassign: 0,
nonblock-statement-body-position: [2, "below"],object-curly-spacing: 0,
no-trailing-spaces: 0,block-spacing: 0,newline-per-chained-call: 0,
no-underscore-dangle: 0,no-loop-func:0,no-await-in-loop: 0,no-shadow: 0,
nonblock-statement-body-position: 0,implicit-arrow-linebreak: 0,
eslint no-unused-vars: 0,no-return-assign: 0,no-sequences: 0, no-unused-vars: 0,
object-curly-newline: 0 */

// @TODO | shadow DOM | why in this order?
// @TODO | LOCALE | fix scroll,  and zip labels not showing
// @TODO | action.scroll | try catch or if statement?
// @TODO | README | create, and brag about its features
// @TODO | action.scroll | edge detection incl. backup a bit and try a few times

(function PinterestDownloader() {
    'use strict';

    const DEBUG = false;
    const create$p = console => Object.keys(console).map(k => [
        k, (...args) => DEBUG
            ? console[k](`pin_dl: ${args[0]}`, ...args.slice(1))
            : undefined
    ]).reduce((acc, [k, fn]) => ((acc[k] = fn), acc), {});
    const $p = create$p(console);

    // alterable
    const QS_PIN_THUMBS = 'div.appContent div div.gridCentered img:not([src*="60x60_RS"]):not([src*="75x75_RS"]):not([src*="/images/user/"])';
    const SUB_STR_PIN_THUMB = '/236x/';
    const SUB_STR_PIN_ORIG = '/originals/';
    const QS_NAME_INPUT = '.SearchFormInReact .SearchBoxInput';
    const QS_NAME_HEADER = '.boardHeaderWrapper h3';
    const APPROX_NUM_FILES_PER_ZIP = 200;
    const MS_PAUSE_BETWEEN_RUNS = 300;
    const MAX_FILENAME_LENGTH = 80;
    const LANG_FALLBACK = 'en';
    const LOCALE = {
        en: {
            title: 'hyperapp Pin downloader',
            instructions: 'Download fullsize media from your current position on down until you press cancel',
            action: {
                start: 'Start downloading',
                stop: 'Stop',
                download: 'Downloading',
                zip: 'zipping',
                save: 'Saving zip',
                scroll: 'Scrolling',
                none: '-',
                redundant: 'Allready doing that, ignoring'
            },
            toggle: {
                off: 'Cancel',
                on: 'Download'
            }
        },
        nl: {
            title: 'hyperapp Pin downloader',
            instructions: 'Download fullsize media, vanaf je huidige positie naar beneden, tot je annuleert',
            action: {
                start: 'Start met downloaden',
                stop: 'Stop',
                download: 'Downloaden',
                zip: 'Zippen',
                save: 'Zip opslaan',
                scroll: 'Scollen',
                none: '-',
                redundant: 'Daar zijn we al mee bezig, negeer'
            },
            toggle: {
                off: 'Annuleren',
                on: 'Download'
            }
        }
    };

    // helper functions and side effects
    const $ = (s, x = document) => x.querySelector(s);
    const $s = (s, x = document) => x.querySelectorAll(s);
    const $el = (tag, opts) => {
        const el = document.createElement(tag);
        Object.assign(el, opts);
        return el;
    };

    // one-liners from various online sources, o.a. MDN, SO, GreaseFork, 30-seconds-of-code
    /* eslint-disable */
    const truncateString = (str, num) => str.length > num ? str.slice(0, num > 3 ? num - 3 : num) + '...' : str;
    const pick = (obj, arr) => arr.reduce((acc, curr) => (curr in obj && (acc[curr] = obj[curr]), acc), {});
    const parseQuery = s => [...new URLSearchParams(s).entries()].reduce((acc, [k, v]) => ((acc[k] = v), acc), {});
    const stripHTMLTags = str => str.replace(/<[^>]*>/g, "");
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const fileAndExtension = str => str.split('.').reduce((acc, val, i, arr) => (i == arr.length - 1) ? [acc[0].substring(1), val] : [[acc[0], val].join('.')], []);
    /* eslint-enable */
    
    // not strictly needed, pinterest has hashed img src attributes which we could 
    // use, but I felt like doing it so...
    const sha256 = async str => {
        const sb = new TextEncoder('utf-8').encode(str);
        const hb = await crypto.subtle.digest('SHA-256', sb);
        const ha = Array.from(new Uint8Array(hb));
        const hh = ha.map(b => (`00${b.toString(16)}`).slice(-2)).join('');
        return hh;
    };
    
    const findLang = l => {
        // nl-NL --(if not exists)--> nl --(if not exists)--> LANG_FALLBACK(en)
        l = l.toLowerCase();
        if (l in LOCALE)
            return l;
        if (l.length > 2)
            return findLang(l.split('-')[0]);
        return LANG_FALLBACK;
    };
    const _lang = findLang(navigator.language);

    let $app;

    const download = async $img => {
        let url;
        let name;

        if ($img.srcset)
            [url] = $img.srcset.split(',').pop().trim().split(' ');
        if (!url && $img.src)
            url = $img.src.replace(SUB_STR_PIN_THUMB, SUB_STR_PIN_ORIG);
        if (!url && $img.currentSrc)
            url = $img.currentSrc.replace(SUB_STR_PIN_THUMB, SUB_STR_PIN_ORIG);
        if (DEBUG) 
            name = await sha256($img.src);
        else 
            name = truncateString($img.alt.trim(), MAX_FILENAME_LENGTH);
        if (!name) 
            name = `no_title_set_${await sha256($img.src)}`;
        name += `.${fileAndExtension(url)[1] || 'jpg'}`;

        const resp = await fetch(url).catch(e => { $p.error('fetch error, e = %o', e); });
        const blob = await resp.blob().catch(e => { $p.error('blob error, e = %o', e); });
        $app.up();
        return {id: $img.src, blob, name};
    };

    let timeout;
    const resetAction = (delay = 1000) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            $app.action('none');
        }, delay);
    };

    const {app, h} = hyperapp;

    //      _        _
    //  ___| |_ __ _| |_ ___
    // / __| __/ _` | __/ _ \
    // \__ \ || (_| | ||  __/
    // |___/\__\__,_|\__\___|
    //
    const initialState = {
        hidden: true,
        running: false,
        imgs: new Map(), // cannot load here, only 1 or 2 pins available at this point
        name: '', // cannot set here, pinterest delays its dom and content loading
        zip: new JSZip(),
        count: 0,
        lang: _lang,
        l: LOCALE[_lang],
        action: 'none'
    };

    //             _   _
    //   __ _  ___| |_(_) ___  _ __  ___
    //  / _` |/ __| __| |/ _ \| '_ \/ __|
    // | (_| | (__| |_| | (_) | | | \__ \
    //  \__,_|\___|\__|_|\___/|_| |_|___/
    //
    /* @NOTE
    action is an unary function (accepts a single argument)
    action used for side effects does not need to have a return value. */
    /* @NOTE
    action can be an async function. Because async functions return a
    Promise, and not a partial state object, you need to call another
    action in order to update the state. */
    /* @NOTE
    Updating deeply nested state is as easy as declaring actions inside an
    object in the same path as the part of the state you want to update */
    const actions = {
        toggleHidden: () => (state) => ({ hidden: !state.hidden }),
        start: () => async (state, actions) => {
            if (state.running) {
                actions.action('redundant'); resetAction();
                return;
            }
            const running = true;
            const name = ($(QS_NAME_INPUT) || {}).value 
                || ($(QS_NAME_HEADER) || {}).textContent 
                || window.location.pathname.replace(/\//, '_') 
                || `dashboard on ${new Date().toLocaleDateString(state.lang)}`;
            actions.setState({running, name});
            actions.action('start'); resetAction();
            let imgs;
            // this function only here so that we do not "define a functions inside a loop"
            const onlyAllowUnknown = $img => !imgs.has($img.src);
            while (actions.getState('running').running) {
                actions.action('download'); resetAction();
                let $imgs = Array.from($s(QS_PIN_THUMBS));
                ({imgs} = actions.getState('imgs'));
                $imgs = $imgs.filter(onlyAllowUnknown);
                const [...imgBlobs] = await Promise.all($imgs.map($img => download($img)));
                // discouraged `for...of`, why?
                imgBlobs.forEach(actions.zip);
                imgBlobs.forEach(ib => {imgs.set(ib.id, 1);});
                actions.setState({imgs});
                if (Object.keys(actions.getState('zip').zip.files).length >= APPROX_NUM_FILES_PER_ZIP) {
                    await actions.save();
                    actions.setState({zip: new JSZip(), count: 0});
                }
                await actions.scoll({elem: $imgs[$imgs.length - 1]}).catch(e => { $p.error('scroll error, e = %o', e); });
                await sleep(MS_PAUSE_BETWEEN_RUNS); // if we leave this line out ...?
            }
            // your leftovers sir...
            if (Object.keys(actions.getState('zip').zip.files).length)
                await actions.save();
            actions.setState({imgs});
        },
        stop: () => () => ({running: false}),
        zip: imgBlob => state => {
            actions.action('zip'); resetAction();
            state.zip.file(imgBlob.name, imgBlob.blob);
            $p.log('added %s to zip', imgBlob.name);
            return {zip: state.zip};
        },
        save: () => async state => {
            actions.action('save'); resetAction();
            const {zip} = state; // @TODO why? Should have no effect.
            const cont = await zip.generateAsync({type: 'blob'});
            const res = await saveAs(cont, `${state.name}.zip`);
            $p.info(`saved zip ${res}`);
        },
        scoll: ({elem, offset = 0}) => async state => {
            actions.action('scoll'); resetAction();
            let targetPosition;
            try {
                const rect = elem.getBoundingClientRect();
                targetPosition = rect.top + window.pageYOffset + offset;
            } catch (e) {
                if (e instanceof TypeError) { // elem is undefined
                    const pinsCont = $('.appContent');
                    targetPosition = parseInt(window.getComputedStyle(pinsCont).height, 10) 
                        || window.innerHeight;
                } else throw new Error(e);
            }
            window.scrollTo({ behavior: 'smooth', left: 0, top: targetPosition });

            return new Promise((res, rej) => {
                const fail = setTimeout(() => {rej();}, 4000);
            
                const scrollHandler = () => {
                    if (window.pageYOffset === targetPosition) {
                        window.removeEventListener('scroll', scrollHandler);
                        clearTimeout(fail);
                        res();
                    }
                };
                if (window.pageYOffset === targetPosition) {
                    clearTimeout(fail);
                    res();
                } else {
                    window.addEventListener('scroll', scrollHandler);
                    elem.getBoundingClientRect();
                }
            });
        },
        up: (x = 1) => state => ({count: state.count + x}),
        down: (x = 1) => state => ({count: state.count - x}),
        setState: newState => () => newState,
        getState: (...props) => state => pick(state, props),
        action: value => () => ({action: value})
    };

    // component/ui elements that go into the DOM (normally in jsx)
    const MenuToCross = ({checked, onclick}) => h('div', {class: 'toggle-menu-container'}, [
        h('input', {type: 'checkbox', id: 'toggle-menu', checked}),
        h('label', {for: 'toggle-menu'}, h('span', {class: 'menu-icon', onclick}))
    ]);
    const Button = ({label, action, disabled = false}) => 
        h('button', {onclick: action, disabled}, label);

    const SimpleButton = (label, action) => 
        h('button', {onclick: action}, label);

    const Article = ({title, action, text, ...props}) => h(
        'article', {class: `action_${action}`, ...props}, 
        h('h2', {class: 'truncate-text'}, title), 
        h('p', null, text)
    );

    //        _
    // __   _(_) _____      __
    // \ \ / / |/ _ \ \ /\ / /
    //  \ V /| |  __/\ V  V /
    //   \_/ |_|\___| \_/\_/
    //
    const view = (state, actions) => h('div', {
        className: 'box'
    }, [
        MenuToCross({
            checked: state.hidden ? '' : 'checked',
            onclick: () => actions.toggleHidden()
        }),
        h('div', { className: state.hidden ? 'hidden' : '' }, [
            h('h1', {}, state.l.title),
            h('output', {}, state.count),
            Article({
                title: state.name,
                action: state.action,
                text: state.l.action[state.action],
                'data-atributes': 'work',
                style: {color: 'inherit'}
            }),
            Button({
                label: state.running ? state.l.toggle.off : state.l.toggle.on,
                action: state.running ? actions.stop : actions.start
            }),
            h('footer', {}, state.l.instructions)
        ])
    ]);

    // shadow DOM
    const shadowHost = $el('div', { id: 'pin_dl-shadow-host', style: 'position: absolute; top: 5px; right: 5px;' });
    const shadow = shadowHost.attachShadow
        ? shadowHost.attachShadow({ mode: 'closed' })
        : shadowHost; // no shadow dom

    // container for the app's gui elements
    const container = $el('div', { id: 'pin_dl-container' });
    shadow.appendChild(container);

    //   __ _ _ __  _ __
    //  / _` | '_ \| '_ \
    // | (_| | |_) | |_) |
    //  \__,_| .__/| .__/
    //       |_|   |_|
    // boostrapping @TODO why does this have to be after dom insertion
    $app = app(initialState, actions, view, container);
    if (DEBUG)
        window.$app = $app;

    // show gui elements, attach to dom
    const $body = $('body');
    if ($body && !$body.contains(shadowHost))
        $body.appendChild(shadowHost);

    // customize styling
    shadow.appendChild($el('style', {
        id: 'pin_dl-css',
        textContent: /*css*/`
@charset "UTF-8";
/* hyperapp styling */
:host {
    -webkit-box-align: center;
    -ms-flex-align: center;
    align-items: center;
    background-color: #111;
    display: -webkit-box;
    display: -ms-flexbox;
    display: flex;
    font-family: Helvetica Neue, sans-serif;
    font-smoothing: antialiased;
    -webkit-text-stroke: 0.45px rgba(0, 0, 0, 0.1);
    text-rendering: optimizeLegibility;
    -webkit-box-pack: center;
    -ms-flex-pack: center;
    justify-content: center;
    margin: 0;
    padding: 0;
    text-align: center;
    color: #00caff;
    font-size: 16px;
    line-height: 1;
}
/* menu to cross icon */
.menu-icon {
  font-size: 3em;
  max-width: 45px;
  text-align: center;
  display: block;
  margin: 15% auto;
  cursor: pointer;
  transition: transform .2s ease;
}
.menu-icon:hover {
  transform: scale(0.9);
}
.menu-icon:before, .menu-icon:after {
  line-height: .5;
}
.menu-icon:before {
  content: '☰';
  display: block;
}
.menu-icon:after {
  content: '╳';
  font-size: .75em;
  font-weight: 800;
  display: none;
}
#toggle-menu { display: none; }
#toggle-menu:checked ~ label[for="toggle-menu"] .menu-icon {
  transform: rotate(180deg);
}
#toggle-menu:checked ~ label[for="toggle-menu"] .menu-icon:before {
  display: none;
}
#toggle-menu:checked ~ label[for="toggle-menu"] .menu-icon:after {
  display: block;
}

/* hyperapp styling, cont. */
.box {
    /* position: -webkit-sticky; position: sticky; */
    position: fixed;
    right: 0; top: 0;
    border: 1px solid rgba(0, 202, 255, 0.9);
    padding: 2em 2em 3em;
    z-index: 10000000;
    background-color: black;
    max-width: 250px;
}
output, footer, h1, h2 {
    display: block;
    font-weight: 100;
    margin: 0;
    padding-bottom: 15px;
}
output {
    display: inline;
    font-size: 8em;
}
h1 {
    font-size: 1em;
    opacity: 0.9;
    letter-spacing: 4px;
    font-weight: 100;
    text-transform: uppercase;
}
button {
    background: #111;
    border-radius: 0px;
    border: 1px solid #00caff;
    color: #00caff;
    font-size: 2em;
    font-weight: 100;
    margin: 0;
    outline: none;
    padding: 5px 15px 8px;
    -webkit-transition: background 0.2s;
    transition: background 0.2s;
}
button:hover, button:active, button:disabled {
    background: #00caff;
    color: #111;
}
button:active {
    outline: 2px solid #00caff;
}
button:focus {
    border: 1px solid #00caff;
}
button+button {
    margin-left: 3px;
}
article {
    color: #00caff;
    font-weight: 100;
    margin: 1em 0;
    padding: 1em;
}
article h2 {
    font-size: 4em;
}
article p {
    font-size: 2em;
    margin-top: 0.1em;
    margin-bottom: 0.1em;
}
${Object.keys($app.getState('l').l.action).reduce((s, d, i, a) => {
        s += `article.action_${d} p`;
        if (i < a.length - 1)
            s += ',';
        return s;
    }, '')} {
    -webkit-animation-name: fadeIn;
    animation-name: fadeIn;
    -webkit-animation-duration: 0.4s;
    animation-duration: 0.4s;
}
article.count_- p {
    -webkit-animation-name: fadeOut;
    animation-name: fadeOut;
    -webkit-animation-duration: 0.2s;
    animation-duration: 0.2s;
}
footer {
    margin-top: 1em;
    padding-top: 1em;
    letter-spacing: 1px;
}
@-webkit-keyframes fadeIn {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}
@keyframes fadeIn {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}
@-webkit-keyframes fadeOut {
    from {
        opacity: 1;
    }
    to {
        opacity: 0.2;
    }
}
@keyframes fadeOut {
    from {
        opacity: 1;
    }
    to {
        opacity: 0.2;
    }
}
/* snippets */
.hidden { display: none; }
.reset-all-styles { all: initial; }
.system-font-stack { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, sans-serif; }
.pretty-text-underline { display: inline; text-shadow: 1px 1px #f5f6f9, -1px 1px #f5f6f9, -1px -1px #f5f6f9, 1px -1px #f5f6f9; background-image: linear-gradient(90deg, currentColor 100%, transparent 100%); background-position: bottom; background-repeat: no-repeat; background-size: 100% 1px; }
.pretty-text-underline::-moz-selection { background-color: rgba(0, 150, 255, 0.3); text-shadow: none; }
.pretty-text-underline::selection { background-color: rgba(0, 150, 255, 0.3); text-shadow: none; }
.truncate-text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.hairline-border { box-shadow: 0 0 0 1px; }
@media (min-resolution: 2dppx) {
    .hairline-border { box-shadow: 0 0 0 0.5px; }
}
@media (min-resolution: 3dppx) {
    .hairline-border { box-shadow: 0 0 0 0.33333333px; }
}
@media (min-resolution: 4dppx) {
    .hairline-border { box-shadow: 0 0 0 0.25px; }
}
.hover-underline-animation { display: inline-block; position: relative; color: #0087ca; }
.hover-underline-animation::after { content: '';
  position: absolute; width: 100%; transform: scaleX(0); height: 2px; bottom: 0; left: 0; background-color: #0087ca; transform-origin: bottom right; transition: transform 0.25s ease-out; }
.hover-underline-animation:hover::after { transform: scaleX(1); transform-origin: bottom left; }`
    }));
})();
