export const getStaggeredStartDate = (base: Date, index: number): Date => {
  const offsetDays = index < 8 ? index * 21 : 7 * 21 + (index - 7) * 42;
  const d = new Date(base);
  d.setDate(d.getDate() + offsetDays);
  return d;
};
