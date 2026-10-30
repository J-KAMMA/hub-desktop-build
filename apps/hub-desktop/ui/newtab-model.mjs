// 新しいタブの純粋な部分。DOMにも Tauri にも触れない（試験できるように分けてある）。

export function greeting(date) {
  const hour = date.getHours();
  return hour < 4 ? 'こんばんは' : hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'こんばんは';
}
