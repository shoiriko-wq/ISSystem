  console.log(t.cls, JSON.stringify({ ...info, filtered }));
  await page.screenshot({ path: `scripts/output/bulletin-header-${t.cls}.png` });

  // ミニカレンダーとキー操作の手引きを開いた状態（文字サイズの統一感を確認）
  await page.evaluate(() => {
    document.querySelector('#bulletin-day-current').click();
    document.querySelector('#bulletin-keys-toggle').click();
  });
  await sleep(600);
  await page.screenshot({ path: `scripts/output/bulletin-cal-${t.cls}.png` });

  await page.evaluate(() => { document.querySelector('#bulletin-search-input').value = ''; document.querySelector('#bulletin-search-input').dispatchEvent(new Event('input')); });
  await sleep(300);
}
