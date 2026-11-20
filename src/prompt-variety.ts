const comparisons = {
  english: {
    actions: [
      'Mina checked the ticket at the gate', 'I set the blue cup on the shelf',
      'Jules brought the empty box downstairs', 'We searched the garden for the lost glove',
      'Sam filled a glass at the kitchen sink', 'My brother unlocked the small side door',
      'June packed the bread in a paper bag', 'Someone parked a red bike by the wall',
      'The clerk tied a ribbon around the gift', 'Nora folded the map along the old crease',
    ],
    time: [
      'before lunch', 'just before it rained', 'on the way out', 'a little after noon', 'before leaving',
      'on a cool morning', 'just as the sun came out', 'when the light came on', 'during a short break', 'at the end of the day',
    ],
  },
  chinese: {
    actions: [
      '阿哲在門邊找到掉落的鑰匙', '我把洗好的杯子放回架上',
      '妹妹把折好的地圖塞進口袋', '我們暫時把單車停在牆邊',
      '姐姐替窗台上的薄荷澆水', '爸爸把曬乾的毛巾帶回屋裡',
      '店員用紙袋裝好剛烤的麵包', '朋友把寫好的卡片交給我',
      '弟弟在書架上找到那本漫畫', '我拿出小盒子收好散落的鈕扣',
    ],
    time: [
      '一早', '出門前', '中午休息時', '午後', '天快黑時',
      '雨停以後', '忙完手上的事後', '吃完早餐後', '太陽剛露臉時', '傍晚時',
    ],
  },
};

const holdouts = {
  english: {
    observations: [
      'The notice by the lift had slipped behind a plant.',
      'A row of bikes stood under the bright market awning.',
      'The rain left a shallow pool across the footpath.',
      'The last bus was still waiting at the end of the street.',
      'A few loose postcards had fallen from the rack.',
      'A grey bird landed on the rail next to the stairs.',
      'The music from the shop faded as the door swung shut.',
      'The narrow lane curved sharply behind the library.',
      'A yellow scarf hung from a branch by the playground.',
      'Someone had left a small stack of books on the bench.',
    ],
    endings: [
      'I stopped for a moment before walking home.',
      'We had not passed that way in several weeks.',
      'I took a photo to show my sister after dinner.',
      'A friend caught up with me just around the corner.',
      'I was in no hurry and took the long route home.',
      'The street looked quite different in the evening light.',
      'My brother pointed it out as we walked past.',
      'We talked about it later while we waited for the train.',
      'I made a note of it before putting my phone away.',
      'On the way back, I crossed over to the other side.',
    ],
  },
  chinese: {
    observations: [
      '市場入口旁多了一張長椅，有人坐在那裡等家人。',
      '圖書館外的杜鵑剛開花，枝頭還掛著幾滴雨水。',
      '放學的孩子把傘收起來，排成一列走過巷口。',
      '河邊多了一段新步道，轉角還能看到舊橋。',
      '公車轉進窄街時，店家正把招牌搬到屋裡。',
      '郵筒旁掛著一張失物公告，上頭畫了一把黑傘。',
      '車站外有人在修腳踏車，工具整齊地放在地上。',
      '街角的書店換了窗簾，門口仍留著原來的木椅。',
      '公園入口有一隻橘貓，在樹下慢慢伸了個懶腰。',
      '遠處的鐘剛敲完，路旁的攤販還在收拾桌子。',
    ],
    endings: [
      '我在路口停了一會兒，才繼續往前走。',
      '妹妹放慢腳步，等我一起走到對面。',
      '我們回到家以後，還聊起路上看到的景象。',
      '我拍了一張照片，想晚點拿給家人看。',
      '朋友隨後走來，和我一起繞到另一條街。',
      '因為時間還早，我們沿著巷子多走了一段。',
      '晚點經過同一個地方時，天色已經暗了。',
      '爸爸也注意到了，回家路上還特別提了一次。',
      '我拐進旁邊的巷子，順路買了一袋水果。',
      '我們到站牌時，剛好還有幾分鐘可以休息。',
    ],
  },
};

function combine(index: number, first: string[], second: string[]): [string, string] {
  const head = index % first.length;
  const tail = (head + Math.floor(index / first.length)) % second.length;
  return [first[head], second[tail]];
}

export function comparisonText(index: number): [string, string] {
  const { english, chinese } = comparisons;
  const [enAction, enTime] = combine(index, english.actions, english.time);
  const [zhAction, zhTime] = combine(index, chinese.actions, chinese.time);
  return [`${enAction} ${enTime}.`, `${zhTime}，${zhAction}。`];
}

export function holdoutText(index: number): [string, string] {
  const { english, chinese } = holdouts;
  return [
    combine(index, english.observations, english.endings).join(' '),
    combine(index, chinese.observations, chinese.endings).join(''),
  ];
}
