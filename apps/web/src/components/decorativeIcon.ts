import { defineComponent, h, type Component } from "vue";

// Ant 图标根节点自带 role="img" + 英文 aria-label，会混进按钮的可访问名；包一层让图标只做装饰。
export function decorative(Icon: Component): Component {
  const label =
    (Icon as { displayName?: string; name?: string }).displayName ??
    (Icon as { name?: string }).name ??
    "Icon";
  return defineComponent({
    name: `Decorative${label}`,
    inheritAttrs: false,
    setup(_, { attrs }) {
      return () => h(Icon, { "aria-hidden": "true", ...attrs });
    },
  });
}
