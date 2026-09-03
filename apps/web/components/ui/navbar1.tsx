'use client';
// Vendored 21st.dev "shadcnblocks" Navbar1 — responsive marketing navigation with a
// desktop NavigationMenu and a mobile Sheet+Accordion. Assimilated into the landing
// page header. Logo points to a local asset (no external fetch — gov-egress safe).
import { Book, Menu, Sunset, Trees, Zap } from 'lucide-react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

interface MenuItem {
  title: string;
  url: string;
  description?: string;
  icon?: JSX.Element;
  items?: MenuItem[];
}

interface Navbar1Props {
  logo?: { url: string; src: string; alt: string; title: string };
  menu?: MenuItem[];
  mobileExtraLinks?: { name: string; url: string }[];
  auth?: {
    login: { text: string; url: string };
    signup?: { text: string; url: string };
  };
}

const Navbar1 = ({
  logo = {
    url: '/',
    src: '/anchor-mark.png',
    alt: 'Anchor',
    title: 'Anchor',
  },
  menu = [
    { title: 'Home', url: '/' },
    {
      title: 'Platform',
      url: '#',
      items: [
        { title: 'ITSM & ITIL', description: 'Incidents, requests, change, problem', icon: <Book className="size-5 shrink-0" />, url: '/login' },
        { title: 'On-call & Major Incident', description: 'Rotations, paging, escalation, bridges', icon: <Zap className="size-5 shrink-0" />, url: '/login' },
        { title: 'Security Posture', description: 'Findings, evidence, remediation, POA&M', icon: <Trees className="size-5 shrink-0" />, url: '/login' },
        { title: 'CMDB & Assets', description: 'Configuration items and dependencies', icon: <Sunset className="size-5 shrink-0" />, url: '/login' },
      ],
    },
    {
      title: 'Solutions',
      url: '#',
      items: [
        { title: 'MSP / CSP', description: 'Operate many isolated customer tenants', icon: <Zap className="size-5 shrink-0" />, url: '/signup' },
        { title: 'Government Cloud', description: 'GCC, GCC High, Azure Government enclaves', icon: <Sunset className="size-5 shrink-0" />, url: '/signup' },
        { title: 'Compliance', description: 'NIST, CMMC, FedRAMP evidence by default', icon: <Trees className="size-5 shrink-0" />, url: '/signup' },
        { title: 'Microsoft 365', description: 'Graph, Teams, and email integrations', icon: <Book className="size-5 shrink-0" />, url: '/signup' },
      ],
    },
  ],
  mobileExtraLinks = [
    { name: 'Security', url: '#' },
    { name: 'Compliance', url: '#' },
    { name: 'Status', url: '#' },
    { name: 'Contact', url: '#' },
  ],
  auth = {
    login: { text: 'Log in', url: '/login' },
    signup: { text: 'Sign up', url: '/signup' },
  },
}: Navbar1Props) => {
  return (
    <section className="py-4">
      <div className="container">
        <nav className="hidden justify-between lg:flex">
          <div className="flex items-center gap-6">
            <a href={logo.url} className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logo.src} className="w-8" alt={logo.alt} />
              <span className="text-lg font-semibold">{logo.title}</span>
            </a>
            <div className="flex items-center">
              <NavigationMenu>
                <NavigationMenuList>{menu.map((item) => renderMenuItem(item))}</NavigationMenuList>
              </NavigationMenu>
            </div>
          </div>
          <div className="flex gap-2">
            <Button asChild variant={auth.signup ? 'outline' : 'default'} size="sm">
              <a href={auth.login.url}>{auth.login.text}</a>
            </Button>
            {auth.signup && (
              <Button asChild size="sm">
                <a href={auth.signup.url}>{auth.signup.text}</a>
              </Button>
            )}
          </div>
        </nav>

        <div className="block lg:hidden">
          <div className="flex items-center justify-between">
            <a href={logo.url} className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logo.src} className="w-8" alt={logo.alt} />
              <span className="text-lg font-semibold">{logo.title}</span>
            </a>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="icon">
                  <Menu className="size-4" />
                </Button>
              </SheetTrigger>
              <SheetContent className="overflow-y-auto">
                <SheetHeader>
                  <SheetTitle>
                    <a href={logo.url} className="flex items-center gap-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={logo.src} className="w-8" alt={logo.alt} />
                      <span className="text-lg font-semibold">{logo.title}</span>
                    </a>
                  </SheetTitle>
                </SheetHeader>
                <div className="my-6 flex flex-col gap-6">
                  <Accordion type="single" collapsible className="flex w-full flex-col gap-4">
                    {menu.map((item) => renderMobileMenuItem(item))}
                  </Accordion>
                  <div className="border-t py-4">
                    <div className="grid grid-cols-2 justify-start">
                      {mobileExtraLinks.map((link, idx) => (
                        <a
                          key={idx}
                          className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-accent-foreground"
                          href={link.url}
                        >
                          {link.name}
                        </a>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-3">
                    <Button asChild variant={auth.signup ? 'outline' : 'default'}>
                      <a href={auth.login.url}>{auth.login.text}</a>
                    </Button>
                    {auth.signup && (
                      <Button asChild>
                        <a href={auth.signup.url}>{auth.signup.text}</a>
                      </Button>
                    )}
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </section>
  );
};

const renderMenuItem = (item: MenuItem) => {
  if (item.items) {
    return (
      <NavigationMenuItem key={item.title} className="text-muted-foreground">
        <NavigationMenuTrigger>{item.title}</NavigationMenuTrigger>
        <NavigationMenuContent>
          <ul className="w-80 p-3">
            <NavigationMenuLink>
              {item.items.map((subItem) => (
                <li key={subItem.title}>
                  <a
                    className="flex select-none gap-4 rounded-md p-3 leading-none no-underline outline-none transition-colors hover:bg-muted hover:text-accent-foreground"
                    href={subItem.url}
                  >
                    {subItem.icon}
                    <div>
                      <div className="text-sm font-semibold">{subItem.title}</div>
                      {subItem.description && (
                        <p className="text-sm leading-snug text-muted-foreground">{subItem.description}</p>
                      )}
                    </div>
                  </a>
                </li>
              ))}
            </NavigationMenuLink>
          </ul>
        </NavigationMenuContent>
      </NavigationMenuItem>
    );
  }

  return (
    <a
      key={item.title}
      className="group inline-flex h-10 w-max items-center justify-center rounded-md bg-background px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-accent-foreground"
      href={item.url}
    >
      {item.title}
    </a>
  );
};

const renderMobileMenuItem = (item: MenuItem) => {
  if (item.items) {
    return (
      <AccordionItem key={item.title} value={item.title} className="border-b-0">
        <AccordionTrigger className="py-0 font-semibold hover:no-underline">{item.title}</AccordionTrigger>
        <AccordionContent className="mt-2">
          {item.items.map((subItem) => (
            <a
              key={subItem.title}
              className="flex select-none gap-4 rounded-md p-3 leading-none outline-none transition-colors hover:bg-muted hover:text-accent-foreground"
              href={subItem.url}
            >
              {subItem.icon}
              <div>
                <div className="text-sm font-semibold">{subItem.title}</div>
                {subItem.description && (
                  <p className="text-sm leading-snug text-muted-foreground">{subItem.description}</p>
                )}
              </div>
            </a>
          ))}
        </AccordionContent>
      </AccordionItem>
    );
  }

  return (
    <a key={item.title} href={item.url} className="font-semibold">
      {item.title}
    </a>
  );
};

export { Navbar1 };
