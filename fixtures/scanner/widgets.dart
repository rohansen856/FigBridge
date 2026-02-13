import 'package:flutter/widgets.dart';

/// Checkout screen.
/// @figma F7KQ9M2X4P6D
class CheckoutScreen extends StatelessWidget {
  const CheckoutScreen({super.key});

  static const banner = 'Use @figma ABCDEFGHJKMN in a string'; // not an annotation

  /// @figma H2C4N6P8R0T2
  Widget header() => const Text('Order details');

  @override
  Widget build(BuildContext context) {
    final raw = r'@figma ABCDEFGHJKMN raw';
    final multi = '''
      @figma ABCDEFGHJKMN triple
    ''';
    return Column(
      children: [
        // @figma 8J3TD9PH6Q2W
        const CheckoutSummaryCard(),
        header(),
      ],
    );
  }
}

/// @figma 8J3TD9PH6Q2W
@immutable
class CheckoutSummaryCard extends StatelessWidget {
  const CheckoutSummaryCard({super.key});

  @override
  Widget build(BuildContext context) => const Placeholder();
}

/* @figma K4M6P8R0T2V4 */
Widget priceTag(int cents) {
  return Text('$cents');
}

// @figma W2X4Y6Z8A0B2
final theme = ThemeData();

mixin Tappable {}

// @figma f7kq9m2x4p6d lower-case, still recognised
// @figma F7KQ9M2X4P6 too short
// see @figma-ref F7KQ9M2X4P6D and mail@figma.com — neither is a directive
