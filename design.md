# Initial Notes 

## What the agent sees, and why

 - A screenshot takes a lot of tokens + the agent would need to guess for elements might not be totally accurate
 - Raw HTML might be super lengthy and can have things that we might not need at all ( classes, ids etc.)
 
 My Pick: 
   - Accessiblity tree but canvas apps would have empty accessiblity tree in the beggining so a hybrid sort of approach where if there is something in the accessiblity tree go with it else take a screenshot  as a fallback . We would need to trim down elements from the tree that might not be needed like hidden nodes etc.  

   Accessiblity tree would look something like: 
     - textbox "Enter your email"
     - button "Sign In"


## Naming the Elements 

 - If we just pass the let's say the button field name, let's say like click sign in or things like it, but there might be two different or three sign-in buttons or same text there, so it will be difficult for the agent to know where to click

 - We can send a CSS selector like ID or class but in the step one itself the agent is not seeing the HTML so we will not be able to do that either

 - The best approach will be to provide some identifier to the snapshot that we are taking in the first step, whatever the agent sees, it should be having like it sees the accessibility, so it sees the text box. So provide a special ID or identifier to it and then reserve that identifier like click let's say we have given it an ID like one, so click one now every like node or element in the accessibility tree will have a unique ID so that should work

 - But for if we are only doing things on the canvas, we should be okay with coordinates as well


## How you know a page has finished reacting

So when in the second step you know when aaction would happen like click happens or something like that happens anything could happen like the page would navigate to a different URL it would refresh an animation would come or something could happen how would we know the page has finished reacting if we take a snapshot early the page might already be loading or it might not have shown the content that it we need or if we are too late the agent would be wasting its time and you know burning the time


- So we can actually watch the network tab to see if there are no no requests firing and if there are no requests it means yeah that a page has finished reacting

- Or we can just look at the DOM. So, if the DOM state is not changing, like we can observe the DOM with some way, and if the DOM state It remains thus like it changes after like say a certain amount of time and it is unchanged after that it means like re-render has happened or something has happened on the page and it means the same

## how the agent learns what an action didhow the agent learns what an action did
 

- A diff would be a good thing which shows what changed from the original state in the accessibility tree. for eg: 

    textbox "enter your email" [2] -> textbox "Enter otp" [5]
    url "/login" -> url "/login/verify"


## Left out 

- Captachas 
- Extension popups 
- OS Dialogs like file picker etc 

