export const plateRotationFixtures = {
  ranking: {
    html: [
      "<div style='line-height:160%;'>2026-06-10</div>",
      "<span class='rank'>1</span>",
      "<td class='plate plate801001' code='801001' name='芯片'>",
      "<span>芯片</span><br><span style='color:red;'>12811</span></td>",
      "<span class='rank'>2</span>",
      "<td class='plate plate801660' code='801660' name='通信'>",
      "<span>通信</span><br><span style='color:red;'>5377</span></td>",
    ].join(""),
  },
  curve: {
    date: ["06-10", "06-09"],
    name: { "1": "芯片(2次上榜)" },
    "1": [
      { value: "1", symbol: "image:///static/img/rank1.png" },
      { value: 10.5, symbol: "image:///static/img/wu.png" },
    ],
  },
  heads: {
    html: [
      "<td style='text-align:left;padding-bottom:5px;'>",
      "<div class='kline' code='603938'><span>龙一</span>三孚股份</div>",
      "<div class='kline' code='002636'><span>龙二</span>金安国纪</div>",
      "<td style='text-align:center;color:#bbb;'>当日无领涨</div>",
    ].join(""),
  },
  strength: {
    legend: "通信",
    date: ["06-10", "06-09"],
    series1: [5377, 24089],
    series2: [9239, 9992],
  },
};
