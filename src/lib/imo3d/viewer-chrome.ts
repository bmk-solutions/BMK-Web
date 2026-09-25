import {withBasePath} from "./base-path.ts";

/**
 * The public tour belongs to the developer's buyer, not to the studio. Its logo and error page lead
 * to the studio only for a signed-in administrator (who previews there); for a buyer the suite's
 * login would be a dead end, so they get no link at all. An embed never links out.
 */
export function studioLink({embedded,admin}:{embedded:boolean;admin:boolean}):string|null{
 return admin&&!embedded?withBasePath("/"):null;
}
