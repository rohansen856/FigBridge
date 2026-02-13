import React from 'react';

const label = "@figma ABCDEFGHJKMN in a string";
const tpl = `@figma ABCDEFGHJKMN ${label} template`;

// @figma F7KQ9M2X4P6D
export function CheckoutScreen() {
  return (
    <main>
      {/* @figma 8J3TD9PH6Q2W */}
      <CheckoutSummaryCard total={3} />
      <p>@figma ABCDEFGHJKMN is JSX text, not a comment</p>
    </main>
  );
}

/**
 * Summary card.
 * @figma 8J3TD9PH6Q2W
 */
export const CheckoutSummaryCard = ({ total }: { total: number }) => {
  /* @figma H2C4N6P8R0T2 */
  const Row = () => <div>{total}</div>;
  return <section aria-label="Checkout summary"><Row /></section>;
};

// @figma K4M6P8R0T2V4
@observer
export default class PriceTag extends React.Component {
  // @figma W2X4Y6Z8A0B2
  render() {
    return null;
  }
}

const n = 1; // @figma Q1R2S3T4V5W6
