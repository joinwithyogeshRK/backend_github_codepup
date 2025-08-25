-- CreateTable
CREATE TABLE "public"."Github" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "token" TEXT NOT NULL,

    CONSTRAINT "Github_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Repos" (
    "id" SERIAL NOT NULL,
    "github_user_id" INTEGER NOT NULL,

    CONSTRAINT "Repos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Github_username_key" ON "public"."Github"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Github_token_key" ON "public"."Github"("token");

-- AddForeignKey
ALTER TABLE "public"."Repos" ADD CONSTRAINT "Repos_github_user_id_fkey" FOREIGN KEY ("github_user_id") REFERENCES "public"."Github"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
