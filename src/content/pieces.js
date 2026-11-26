// كتالوج قطع Osmo Coding المتوفرة فعليًا (مؤكد من صورة المستخدم 2026-11-26 ومطابق لوثائق Osmo: 31 قطعة).
// محتوى منفصل عن الكود: يستخدمه محرك الرؤية (ما الذي نبحث عنه) ومولد المراحل (حدود المخزون).

export const PIECES = [
  { id: 'walk',   nameAr: 'مشي',   color: 'blue',        symbol: 'runner',      count: 6, hasArrow: true,  acceptsNumber: true,  meaning: 'خطوة باتجاه السهم' },
  { id: 'jump',   nameAr: 'قفز',   color: 'red',         symbol: 'jumper',      count: 3, hasArrow: true,  acceptsNumber: true,  meaning: 'قفز فوق مربع (حركة مربعين)' },
  { id: 'hand',   nameAr: 'يد',    color: 'orange',      symbol: 'hand',        count: 3, hasArrow: true,  acceptsNumber: true,  meaning: 'التقاط/تفاعل مع المربع المجاور باتجاه السهم' },
  { id: 'rest',   nameAr: 'راحة',  color: 'dark-purple', symbol: 'zzz',         count: 2, hasArrow: false, acceptsNumber: true,  meaning: 'انتظار' },
  { id: 'repeat', nameAr: 'تكرار', color: 'gray',        symbol: 'loop',        count: 2, hasArrow: false, acceptsNumber: true,  meaning: 'تكرار تسلسل' },
  { id: 'magic',  nameAr: 'سحر',   color: 'magenta',     symbol: 'stars',       count: 1, hasArrow: false, acceptsNumber: false, meaning: 'قدرة خاصة بالمرحلة' },
  { id: 'func-square', nameAr: 'دالة المربع',  color: 'teal', symbol: 'square', count: 1, hasArrow: false, acceptsNumber: true, meaning: 'استدعاء دالة' },
  { id: 'func-circle', nameAr: 'دالة الدائرة', color: 'teal', symbol: 'circle', count: 1, hasArrow: false, acceptsNumber: true, meaning: 'استدعاء دالة' },
  { id: 'func-star',   nameAr: 'دالة النجمة',  color: 'teal', symbol: 'star',   count: 1, hasArrow: false, acceptsNumber: true, meaning: 'استدعاء دالة' },
  { id: 'num-2', nameAr: '٢', color: 'yellow', symbol: 'digit-2', count: 3, isNumber: true, value: 2 },
  { id: 'num-3', nameAr: '٣', color: 'yellow', symbol: 'digit-3', count: 3, isNumber: true, value: 3 },
  { id: 'num-4', nameAr: '٤', color: 'yellow', symbol: 'digit-4', count: 3, isNumber: true, value: 4 },
  { id: 'num-5', nameAr: '٥', color: 'yellow', symbol: 'digit-5', count: 2, isNumber: true, value: 5 },
];

// لا توجد قطعة «تشغيل»: يبدأ البرنامج بلمس زر كبير على الشاشة (كما في ألعاب Osmo الرسمية).
export const RUN_TRIGGER = 'screen-tap';

export const inventory = () => Object.fromEntries(PIECES.map((p) => [p.id, p.count]));
export const totalPieces = () => PIECES.reduce((s, p) => s + p.count, 0);
export const byColor = (color) => PIECES.filter((p) => p.color === color);
