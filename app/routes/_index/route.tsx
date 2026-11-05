import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const query = url.searchParams.toString();
  throw redirect(query ? `/app?${query}` : "/app");
};

export default function IndexRoute() {
  return null;
}
