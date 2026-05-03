import { render } from "@react-email/render";
import { createElement, type FC } from "react";

export interface EmailTemplate<P> {
  Component: FC<P>;
  subject: (props: P) => string;
}

export async function renderEmail<P>(
  template: EmailTemplate<P>,
  props: P,
): Promise<{ html: string; text: string; subject: string }> {
  /* createElement generics vs @react-email/render overloads — props are validated by each template's FC<P> */
  const Cmp = template.Component as FC<Record<string, unknown>>;
  const element = createElement(Cmp, props as Record<string, unknown>);
  const html = await render(element);
  const text = await render(element, {
    plainText: true,
  });
  return {
    html,
    text,
    subject: template.subject(props),
  };
}
