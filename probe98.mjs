import { launch, sleep } from "./scripts/cdp.js";
const page = await launch();
await page.goto("http://localhost:7777/");
await sleep(3000);
await page.fill(".prompt textarea", "say ok");
await page.keyPress("Enter");
for(let i=0;i<40;i++){ await sleep(800);
  const st=await page.eval("document.querySelector('.status')?.innerText||''"); if(!st.includes("running")&&i>2)break; }
console.log("toasts:", await page.eval("[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' / ')||'(none)'"));
console.log("snap in status:", await page.eval("document.querySelector('.status .r')?.textContent"));
await page.close();
